CLASS zcl_zzapi_mes_gr DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_gr IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Goods receipt (PO) — Strategy D ICF REST endpoint.
    " POST only. Calls BAPI_GOODSMVT_CREATE with movement 101, mvt_ind='B'.
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
        DATA: lv_ebeln  TYPE ebeln,
              lv_ebelp  TYPE ebelp,
              lv_menge  TYPE menge_d,
              lv_werks  TYPE werks_d,
              lv_lgort  TYPE lgort_d,
              lv_budat  TYPE budat,
              lv_charg  TYPE charg_d.

        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'ebeln' CHANGING cv_value = lv_ebeln ).
        zcl_zzapi_mes_utils=>extract_field(
          EXPORTING iv_json = lv_body iv_field = 'ebelp' CHANGING cv_value = lv_ebelp ).
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

        IF lv_ebeln IS INITIAL OR lv_ebelp IS INITIAL OR lv_menge IS INITIAL
            OR lv_werks IS INITIAL OR lv_lgort IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing required fields: ebeln, ebelp, menge, werks, lgort"}' ).
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

        ls_code-gm_code = '01'.  " Goods receipt for purchase order

        IF lv_budat IS NOT INITIAL.
          ls_header-pstng_date = lv_budat.
          ls_header-doc_date   = lv_budat.
        ENDIF.

        ls_item-move_type  = '101'.    " Goods receipt
        ls_item-mvt_ind    = 'B'.      " Purchase order
        ls_item-po_number  = lv_ebeln.
        ls_item-po_item    = lv_ebelp.
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
          DATA: lt_err_return TYPE TABLE OF bapiret2.
          LOOP AT lt_return INTO ls_return WHERE type = 'E' OR type = 'A'.
            APPEND ls_return TO lt_err_return.
          ENDLOOP.
          DATA: lv_err_json TYPE string.
          lv_err_json = zz_cl_json=>serialize(
            data        = lt_err_return
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
          CONCATENATE '{"ebeln":"' lv_ebeln '","ebelp":"' lv_ebelp '","status":"error","errors":' lv_err_json '}'
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
          CONCATENATE '{"ebeln":"' lv_ebeln '","ebelp":"' lv_ebelp '",'
            '"menge":' lv_menge_str ','
            '"materialDocument":"' lv_matdoc '",'
            '"documentYear":"' lv_docyear '",'
            '"status":"posted","message":"Goods receipt posted"}'
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
