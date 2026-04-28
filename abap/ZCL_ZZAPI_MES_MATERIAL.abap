CLASS zcl_zzapi_mes_material DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_material IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Material master lookup — Strategy D ICF REST endpoint.
    " Returns MARA (general) + MARC (plant) + MAKT (description).
    " Tables: MARA, MARC, MAKT.

    DATA: lv_method TYPE string,
          lv_matnr  TYPE matnr,
          lv_werks  TYPE werks_d,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_matnr  = server->request->get_form_field( 'matnr' ).
    lv_werks  = server->request->get_form_field( 'werks' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_matnr IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing matnr parameter"}' ).
          RETURN.
        ENDIF.

        " Reject special characters — prevents injection for direct SAP callers.
        IF zcl_zzapi_mes_utils=>is_valid_id( lv_matnr ) = abap_false
          OR ( lv_werks IS NOT INITIAL AND zcl_zzapi_mes_utils=>is_valid_id( lv_werks ) = abap_false ).
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Invalid characters in query parameter"}' ).
          RETURN.
        ENDIF.

        " --- General material data (MARA) ---
        DATA: ls_mara TYPE mara.
        SELECT SINGLE * INTO ls_mara FROM mara WHERE matnr = lv_matnr.
        IF sy-subrc <> 0.
          server->response->set_status( code = 404 reason = 'Not Found' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Material not found"}' ).
          RETURN.
        ENDIF.

        DATA: lv_mara_json TYPE string.
        lv_mara_json = zz_cl_json=>serialize(
          data        = ls_mara
          compress    = abap_true
          pretty_name = zz_cl_json=>pretty_mode-camel_case ).

        " --- Material description (MAKT) ---
        DATA: ls_makt TYPE makt.
        SELECT SINGLE * INTO ls_makt FROM makt
          WHERE matnr = lv_matnr
            AND spras = sy-langu.
        DATA: lv_maktx TYPE string.
        lv_maktx = ls_makt-maktx.

        " --- Plant-level data (MARC) — optional ---
        DATA: lv_marc_json TYPE string.
        IF lv_werks IS NOT INITIAL.
          DATA: ls_marc TYPE marc.
          SELECT SINGLE * INTO ls_marc FROM marc
            WHERE matnr = lv_matnr
              AND werks = lv_werks.
          IF sy-subrc = 0.
            lv_marc_json = zz_cl_json=>serialize(
              data        = ls_marc
              compress    = abap_true
              pretty_name = zz_cl_json=>pretty_mode-camel_case ).
          ELSE.
            lv_marc_json = 'null'.
          ENDIF.
        ELSE.
          lv_marc_json = 'null'.
        ENDIF.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"matnr":"' lv_matnr '",'
            '"maktx":"' lv_maktx '",'
            '"general":' lv_mara_json ','
            '"plant":' lv_marc_json
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
