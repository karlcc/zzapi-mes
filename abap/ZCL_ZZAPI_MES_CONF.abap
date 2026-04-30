CLASS zcl_zzapi_mes_conf DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_conf IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Production order confirmation — Strategy D ICF REST endpoint.
    " POST only. Calls BAPI_PRODORDCONF_CREATE_TT.
    " Commits on success, rolls back on failure.

    DATA: lv_method    TYPE string,
          lv_json      TYPE string,
          lv_yield_str TYPE string,
          lv_scrap_str TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).

    CASE lv_method.
      WHEN 'POST'.
        " --- Parse JSON body ---
        DATA: lv_body TYPE string.
        lv_body = server->request->get_cdata( ).

        IF lv_body IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing request body"}' ).
          RETURN.
        ENDIF.

        " --- Extract fields from JSON body ---
        " extract_field CHANGING cv_value TYPE string — use string temporaries
        " then convert to DDIC types for BAPI call.
        DATA: lv_orderid_str   TYPE string,
              lv_operation_str TYPE string,
              lv_yield_str_ext TYPE string,
              lv_scrap_str_ext TYPE string,
              lv_work_act_str  TYPE string,
              lv_postg_date_str TYPE string,
              lv_fin_conf      TYPE string,
              lv_orderid       TYPE aufnr,
              lv_operation     TYPE vornr,
              lv_yield         TYPE gamng,
              lv_scrap         TYPE gamng,
              lv_work_act      TYPE vgwrt,
              lv_postg_date    TYPE budat.

        " Simple JSON field extraction (SAP_BASIS 700 — no /UI2/CL_JSON)
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'orderid' CHANGING cv_value = lv_orderid_str ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'operation' CHANGING cv_value = lv_operation_str ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'yield' CHANGING cv_value = lv_yield_str_ext ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'scrap' CHANGING cv_value = lv_scrap_str_ext ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'work_actual' CHANGING cv_value = lv_work_act_str ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'postg_date' CHANGING cv_value = lv_postg_date_str ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'fin_conf' CHANGING cv_value = lv_fin_conf ).

        " Convert string extractions to DDIC types for BAPI call
        lv_orderid    = lv_orderid_str.
        lv_operation  = lv_operation_str.
        lv_yield      = lv_yield_str_ext.
        lv_scrap      = lv_scrap_str_ext.
        lv_work_act   = lv_work_act_str.
        lv_postg_date = lv_postg_date_str.

        IF lv_orderid IS INITIAL OR lv_operation IS INITIAL OR lv_yield IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing required fields: orderid, operation, yield"}' ).
          RETURN.
        ENDIF.

        " --- Call BAPI_PRODORDCONF_CREATE_TT ---
        DATA: ls_timeticket TYPE bapi_pp_timeticket,
              lt_timetickets TYPE TABLE OF bapi_pp_timeticket,
              ls_ret1       TYPE bapiret1,
              lt_detail     TYPE TABLE OF bapi_coru_return,
              ls_detail     TYPE bapi_coru_return.

        ls_timeticket-orderid      = lv_orderid.
        ls_timeticket-operation    = lv_operation.
        ls_timeticket-yield        = lv_yield.
        ls_timeticket-scrap        = lv_scrap.
        " BAPI_PP_TIMETICKET has no WORK_ACTUAL — map to CONF_ACTIVITY1
        " (actual activity for the first standard value key in the routing).
        IF lv_work_act IS NOT INITIAL.
          ls_timeticket-conf_activity1 = lv_work_act.
        ENDIF.
        IF lv_postg_date IS NOT INITIAL.
          ls_timeticket-postg_date = lv_postg_date.
        ENDIF.
        " FIN_CONF = 'X' means final confirmation; space means partial.
        " Our API: fin_conf "X" or omitted → final; any other value → partial.
        IF lv_fin_conf IS INITIAL OR lv_fin_conf = 'X'.
          ls_timeticket-fin_conf = abap_true.  " Final confirmation
        ELSE.
          ls_timeticket-fin_conf = space.       " Partial confirmation
        ENDIF.

        " BAPI_PRODORDCONF_CREATE_TT takes TIMETICKETS as a TABLE parameter.
        APPEND ls_timeticket TO lt_timetickets.

        CALL FUNCTION 'BAPI_PRODORDCONF_CREATE_TT'
          IMPORTING
            return        = ls_ret1
          TABLES
            timetickets   = lt_timetickets
            detail_return = lt_detail.

        " --- Check for errors ---
        " ls_ret1 is BAPIRET1 (single structure), lt_detail is BAPI_CORU_RETURN table.
        " Check both for errors.
        DATA: lv_has_error TYPE abap_bool.
        IF ls_ret1-type = 'E' OR ls_ret1-type = 'A'.
          lv_has_error = abap_true.
        ENDIF.
        LOOP AT lt_detail INTO ls_detail WHERE type = 'E' OR type = 'A'.
          lv_has_error = abap_true.
          EXIT.
        ENDLOOP.

        IF lv_has_error = abap_true.
          CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
          " Collect error messages from both BAPIRET1 and DETAIL_RETURN
          TYPES: BEGIN OF lty_bapi_msg,
                   type    TYPE bapiret2-type,
                   message TYPE bapiret2-message,
                 END OF lty_bapi_msg.
          DATA: lt_err_msg TYPE TABLE OF lty_bapi_msg,
                ls_err_msg TYPE lty_bapi_msg.
          IF ls_ret1-type = 'E' OR ls_ret1-type = 'A'.
            ls_err_msg-type    = ls_ret1-type.
            ls_err_msg-message = ls_ret1-message.
            APPEND ls_err_msg TO lt_err_msg.
          ENDIF.
          LOOP AT lt_detail INTO ls_detail WHERE type = 'E' OR type = 'A'.
            ls_err_msg-type    = ls_detail-type.
            ls_err_msg-message = ls_detail-message.
            APPEND ls_err_msg TO lt_err_msg.
          ENDLOOP.
          DATA: lv_err_json TYPE string.
          lv_err_json = zz_cl_json=>serialize(
            data        = lt_err_msg
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
          CONCATENATE '{"orderid":"' lv_orderid '","status":"error","errors":' lv_err_json '}'
            INTO lv_json.
          server->response->set_status( code = 422 reason = 'Unprocessable Entity' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( lv_json ).
        ELSE.
          CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
            EXPORTING wait = abap_true.
          " Extract confirmation number from detail_return or ret1
          DATA: lv_conf_no  TYPE bapi_pp_conf_key-conf_no,
                lv_conf_cnt TYPE bapi_pp_conf_key-conf_cnt.
          " BAPI_CORU_RETURN has CONF_NO and CONF_CNT as direct fields
          " (not in PARAMETER/MESSAGE_V1 as with generic BAPIRET2).
          LOOP AT lt_detail INTO ls_detail WHERE type = 'S' OR type = 'I'.
            IF ls_detail-conf_no IS NOT INITIAL.
              lv_conf_no = ls_detail-conf_no.
            ENDIF.
            IF ls_detail-conf_cnt IS NOT INITIAL.
              lv_conf_cnt = ls_detail-conf_cnt.
            ENDIF.
          ENDLOOP.
          " Format numeric fields with dot as decimal separator (locale-independent)
          " to avoid comma in non-US locales producing invalid JSON.
          lv_yield_str = lv_yield.
          REPLACE ALL OCCURRENCES OF ',' IN lv_yield_str WITH '.'.
          lv_scrap_str = lv_scrap.
          REPLACE ALL OCCURRENCES OF ',' IN lv_scrap_str WITH '.'.
          " scrap=0 produces empty string after CONCATENATE — use '0' instead.
          IF lv_scrap_str IS INITIAL.
            lv_scrap_str = '0'.
          ENDIF.
          CONCATENATE '{"orderid":"' lv_orderid '","operation":"' lv_operation '",'
            '"yield":' lv_yield_str ',"scrap":' lv_scrap_str ','
            '"confNo":"' lv_conf_no '","confCnt":"' lv_conf_cnt '",'
            '"status":"confirmed","message":"Production confirmation recorded"}'
            INTO lv_json.
          server->response->set_status( code = 201 reason = 'Created' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( lv_json ).
        ENDIF.

      WHEN OTHERS.
        server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( '{"error":"Method not allowed"}' ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
