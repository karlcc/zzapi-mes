CLASS zcl_zzapi_mes_gi DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_gi IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Goods issue (consumption for prod order) — Strategy D ICF REST endpoint.
    " POST only. Calls BAPI_GOODSMVT_CREATE with movement 261, mvt_ind='E'.
    " Includes backflush guard: checks AFVC-MGVRG before posting.
    " Commits on success, rolls back on failure.

    DATA: lv_method    TYPE string,
          lv_json      TYPE string,
          lv_menge_str TYPE string.

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

        " --- Extract fields ---
        DATA: lv_orderid TYPE aufnr,
              lv_matnr   TYPE matnr,
              lv_menge   TYPE menge_d,
              lv_werks   TYPE werks_d,
              lv_lgort   TYPE lgort_d,
              lv_budat   TYPE budat,
              lv_charg   TYPE charg_d.

        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'orderid' CHANGING cv_value = lv_orderid ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'matnr' CHANGING cv_value = lv_matnr ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'menge' CHANGING cv_value = lv_menge ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'werks' CHANGING cv_value = lv_werks ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'lgort' CHANGING cv_value = lv_lgort ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'budat' CHANGING cv_value = lv_budat ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'charg' CHANGING cv_value = lv_charg ).

        IF lv_orderid IS INITIAL OR lv_matnr IS INITIAL OR lv_menge IS INITIAL
            OR lv_werks IS INITIAL OR lv_lgort IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing required fields: orderid, matnr, menge, werks, lgort"}' ).
          RETURN.
        ENDIF.

        " --- Backflush guard ---
        " Check if ANY order operation has backflush indicator (AFVC-MGVRG).
        " If backflush is active, the confirmation already handles component GI.
        DATA: ls_afvc TYPE afvc,
              lv_aufpl TYPE afko-aufpl.
        SELECT SINGLE aufpl INTO lv_aufpl FROM afko WHERE aufnr = lv_orderid.
        IF sy-subrc = 0.
          SELECT SINGLE * INTO ls_afvc FROM afvc
            WHERE aufpl = lv_aufpl
              AND mgvrg = abap_true.
        ENDIF.
        IF sy-subrc = 0.
          CONCATENATE '{"orderid":"' lv_orderid '","error":"Backflush is active for this order — GI handled by confirmation"}'
            INTO lv_json.
          server->response->set_status( code = 409 reason = 'Conflict' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( lv_json ).
          RETURN.
        ENDIF.

        " --- Build BAPI structures ---
        DATA: ls_header  TYPE bapi2017_gm_head_01,
              ls_code    TYPE bapi2017_gm_code,
              lt_item    TYPE TABLE OF bapi2017_gm_item_create,
              ls_item    TYPE bapi2017_gm_item_create,
              lt_return  TYPE TABLE OF bapiret2,
              ls_return  TYPE bapiret2,
              lv_matdoc  TYPE bapi2017_gm_head_ret-mat_doc,
              lv_docyear TYPE bapi2017_gm_head_ret-doc_year.

        ls_code-gm_code = '03'.  " Goods issue

        IF lv_budat IS NOT INITIAL.
          ls_header-pstng_date = lv_budat.
          ls_header-doc_date   = lv_budat.
        ENDIF.

        ls_item-move_type  = '261'.    " Consumption for prod order
        ls_item-mvt_ind    = 'E'.      " Goods issue for order
        ls_item-orderid    = lv_orderid.
        ls_item-material   = lv_matnr.
        ls_item-entry_qnt  = lv_menge.
        ls_item-plant      = lv_werks.
        ls_item-stge_loc   = lv_lgort.
        IF lv_charg IS NOT INITIAL.
          ls_item-batch     = lv_charg.
        ENDIF.
        APPEND ls_item TO lt_item.

        CALL FUNCTION 'BAPI_GOODSMVT_CREATE'
          EXPORTING
            goodsmvt_header  = ls_header
            goodsmvt_code    = ls_code
          IMPORTING
            goodsmvt_head_ret-mat_doc  = lv_matdoc
            goodsmvt_head_ret-doc_year = lv_docyear
          TABLES
            goodsmvt_item    = lt_item
            return           = lt_return.

        " --- Check for errors ---
        DATA: lv_has_error TYPE abap_bool.
        LOOP AT lt_return INTO ls_return WHERE type = 'E' OR type = 'A'.
          lv_has_error = abap_true.
          EXIT.
        ENDLOOP.

        IF lv_has_error = abap_true.
          CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
          " Serialize only TYPE+MESSAGE from bapiret2 — strip SAP internals
          TYPES: BEGIN OF lty_bapi_msg,
                   type    TYPE bapiret2-type,
                   message TYPE bapiret2-message,
                 END OF lty_bapi_msg.
          DATA: lt_err_msg TYPE TABLE OF lty_bapi_msg,
                ls_err_msg TYPE lty_bapi_msg.
          LOOP AT lt_return INTO ls_return WHERE type = 'E' OR type = 'A'.
            ls_err_msg-type    = ls_return-type.
            ls_err_msg-message = ls_return-message.
            APPEND ls_err_msg TO lt_err_msg.
          ENDLOOP.
          DATA: lv_err_json TYPE string.
          lv_err_json = zz_cl_json=>serialize(
            data        = lt_err_msg
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
          CONCATENATE '{"orderid":"' lv_orderid '","matnr":"' lv_matnr '","status":"error","errors":' lv_err_json '}'
            INTO lv_json.
          server->response->set_status( code = 422 reason = 'Unprocessable Entity' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( lv_json ).
        ELSE.
          CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
            EXPORTING wait = abap_true.
          " Format menge with dot as decimal separator (locale-independent)
          " to avoid comma in non-US locales producing invalid JSON.
          lv_menge_str = lv_menge.
          REPLACE ALL OCCURRENCES OF ',' IN lv_menge_str WITH '.'.
          CONCATENATE '{"orderid":"' lv_orderid '","matnr":"' lv_matnr '",'
            '"menge":' lv_menge_str ','
            '"materialDocument":"' lv_matdoc '",'
            '"documentYear":"' lv_docyear '",'
            '"status":"posted","message":"Goods issue posted"}'
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
