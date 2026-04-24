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
        DATA: lv_orderid  TYPE aufnr,
              lv_operation TYPE vornr,
              lv_yield     TYPE gamng,
              lv_scrap     TYPE gamng,
              lv_work_act  TYPE vgwrt,
              lv_postg_date TYPE budat.

        " Simple JSON field extraction (SAP_BASIS 700 — no /UI2/CL_JSON)
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'orderid' CHANGING cv_value = lv_orderid ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'operation' CHANGING cv_value = lv_operation ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'yield' CHANGING cv_value = lv_yield ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'scrap' CHANGING cv_value = lv_scrap ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'work_actual' CHANGING cv_value = lv_work_act ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'postg_date' CHANGING cv_value = lv_postg_date ).

        IF lv_orderid IS INITIAL OR lv_operation IS INITIAL OR lv_yield IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing required fields: orderid, operation, yield"}' ).
          RETURN.
        ENDIF.

        " --- Call BAPI_PRODORDCONF_CREATE_TT ---
        DATA: ls_timeticket TYPE bapi_pp_timeticket,
              lt_return     TYPE TABLE OF bapiret2,
              ls_return     TYPE bapiret2,
              lv_conf_no    TYPE bapi_pp_conf_key-conf_no,
              lv_conf_cnt   TYPE bapi_pp_conf_key-conf_cnt.

        ls_timeticket-orderid      = lv_orderid.
        ls_timeticket-operation    = lv_operation.
        ls_timeticket-yield        = lv_yield.
        ls_timeticket-scrap        = lv_scrap.
        ls_timeticket-work_actual  = lv_work_act.
        IF lv_postg_date IS NOT INITIAL.
          ls_timeticket-postg_date = lv_postg_date.
        ENDIF.
        ls_timeticket-fin_conf     = abap_true.  " Final confirmation flag

        CALL FUNCTION 'BAPI_PRODORDCONF_CREATE_TT'
          EXPORTING
            timeticket   = ls_timeticket
          IMPORTING
            confirmed    = lv_conf_no
            conf_counter = lv_conf_cnt
          TABLES
            return       = lt_return.

        " --- Check for errors ---
        DATA: lv_has_error TYPE abap_bool.
        LOOP AT lt_return INTO ls_return WHERE type = 'E' OR type = 'A'.
          lv_has_error = abap_true.
          EXIT.
        ENDLOOP.

        IF lv_has_error = abap_true.
          CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
          DATA: lt_err_return TYPE TABLE OF bapiret2.
          LOOP AT lt_return INTO ls_return WHERE type = 'E' OR type = 'A'.
            APPEND ls_return TO lt_err_return.
          ENDLOOP.
          DATA: lv_err_json TYPE string.
          lv_err_json = zz_cl_json=>serialize(
            data        = lt_err_return
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
          " Format numeric fields with dot as decimal separator (locale-independent)
          " to avoid comma in non-US locales producing invalid JSON.
          lv_yield_str = lv_yield.
          REPLACE ALL OCCURRENCES OF ',' IN lv_yield_str WITH '.'.
          lv_scrap_str = lv_scrap.
          REPLACE ALL OCCURRENCES OF ',' IN lv_scrap_str WITH '.'.
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
