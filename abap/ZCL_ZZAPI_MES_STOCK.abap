CLASS zcl_zzapi_mes_stock DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_stock IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Stock / availability lookup — Strategy D ICF REST endpoint.
    " Returns current stock by plant + storage location.
    " Tables: MARD, MCHB (batch stock).

    DATA: lv_method TYPE string,
          lv_matnr  TYPE matnr,
          lv_werks  TYPE werks_d,
          lv_lgort  TYPE lgort_d,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_matnr  = server->request->get_form_field( 'matnr' ).
    lv_werks  = server->request->get_form_field( 'werks' ).
    lv_lgort  = server->request->get_form_field( 'lgort' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_matnr IS INITIAL OR lv_werks IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing matnr or werks parameter"}' ).
          RETURN.
        ENDIF.

        " Reject special characters — prevents injection for direct SAP callers.
        IF zcl_zzapi_mes_utils=>is_valid_id( lv_matnr ) = abap_false
          OR zcl_zzapi_mes_utils=>is_valid_id( lv_werks ) = abap_false
          OR ( lv_lgort IS NOT INITIAL AND zcl_zzapi_mes_utils=>is_valid_id( lv_lgort ) = abap_false ).
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Invalid characters in query parameter"}' ).
          RETURN.
        ENDIF.

        " --- Storage location stock (MARD) ---
        DATA: lt_mard      TYPE TABLE OF mard,
              ls_mard      TYPE mard,
              lv_mard_json TYPE string.

        IF lv_lgort IS NOT INITIAL.
          SELECT SINGLE * INTO ls_mard FROM mard
            WHERE matnr = lv_matnr
              AND werks = lv_werks
              AND lgort = lv_lgort.
          IF sy-subrc <> 0.
            server->response->set_status( code = 404 reason = 'Not Found' ).
            server->response->set_content_type( 'application/json' ).
            server->response->set_cdata( '{"error":"No stock found for given material/plant/sloc"}' ).
            RETURN.
          ENDIF.
          APPEND ls_mard TO lt_mard.
        ELSE.
          SELECT * INTO TABLE lt_mard FROM mard
            WHERE matnr = lv_matnr
              AND werks = lv_werks.
          IF lines( lt_mard ) = 0.
            server->response->set_status( code = 404 reason = 'Not Found' ).
            server->response->set_content_type( 'application/json' ).
            server->response->set_cdata( '{"error":"No stock found for given material/plant"}' ).
            RETURN.
          ENDIF.
        ENDIF.

        lv_mard_json = zz_cl_json=>serialize(
          data        = lt_mard
          compress    = abap_true
          pretty_name = zz_cl_json=>pretty_mode-camel_case ).

        " --- Batch stock (MCHB) ---
        DATA: lt_mchb TYPE TABLE OF mchb,
              lv_mchb_json TYPE string.
        IF lv_lgort IS NOT INITIAL.
          SELECT * INTO TABLE lt_mchb FROM mchb
            WHERE matnr = lv_matnr
              AND werks = lv_werks
              AND lgort = lv_lgort.
        ELSE.
          SELECT * INTO TABLE lt_mchb FROM mchb
            WHERE matnr = lv_matnr
              AND werks = lv_werks.
        ENDIF.
        IF lines( lt_mchb ) > 0.
          lv_mchb_json = zz_cl_json=>serialize(
            data        = lt_mchb
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_mchb_json = '[]'.
        ENDIF.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"matnr":"' lv_matnr '",'
            '"werks":"' lv_werks '",'
            '"storageLocations":' lv_mard_json ','
            '"batches":' lv_mchb_json
          '}'
          INTO lv_json.

        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( lv_json ).

      WHEN OTHERS.
        server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( '{"error":"Method not allowed"}' ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
