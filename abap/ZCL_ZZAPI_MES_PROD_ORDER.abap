CLASS zcl_zzapi_mes_prod_order DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_prod_order IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Production order detail — Strategy D ICF REST endpoint.
    " Returns order header + operations + component reservations.
    " Tables: AUFK, AFKO, AFPO, AFVV (via CAUFV), RESB.

    DATA: lv_method TYPE string,
          lv_aufnr  TYPE aufnr,
          lt_fields TYPE TABLE OF dfies,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_aufnr  = server->request->get_form_field( 'aufnr' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_aufnr IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing aufnr parameter"}' ).
          RETURN.
        ENDIF.

        " --- Order header ---
        DATA: ls_aufk TYPE aufk,
              ls_afko TYPE afko,
              ls_afpo TYPE afpo.

        SELECT SINGLE * INTO ls_aufk FROM aufk WHERE aufnr = lv_aufnr.
        IF sy-subrc <> 0.
          server->response->set_status( code = 404 reason = 'Not Found' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Production order not found"}' ).
          RETURN.
        ENDIF.

        SELECT SINGLE * INTO ls_afko FROM afko WHERE aufnr = lv_aufnr.
        SELECT SINGLE * INTO ls_afpo FROM afpo WHERE aufnr = lv_aufnr.

        " --- Build header JSON ---
        DATA: lv_header_json TYPE string.
        lv_header_json = zz_cl_json=>serialize(
          data        = ls_afko
          compress    = abap_true
          pretty_name = zz_cl_json=>pretty_mode-camel_case ).

        " --- Operations (AFVC by AUFPL from AFKO) ---
        DATA: lt_ops      TYPE TABLE OF afvc,
              lv_ops_json TYPE string.
        IF ls_afko-aufpl IS NOT INITIAL.
          SELECT * INTO TABLE lt_ops FROM afvc
            WHERE aufpl = ls_afko-aufpl
            ORDER BY vornr.
        ENDIF.
        IF lines( lt_ops ) > 0.
          lv_ops_json = zz_cl_json=>serialize(
            data        = lt_ops
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_ops_json = '[]'.
        ENDIF.

        " --- Component reservations (RESB) ---
        DATA: lt_resb TYPE TABLE OF resb,
              lv_resb_json TYPE string.
        SELECT * INTO TABLE lt_resb FROM resb
          WHERE aufnr = lv_aufnr
            AND xloek = abap_false
          ORDER BY rsnum.
        IF lines( lt_resb ) > 0.
          lv_resb_json = zz_cl_json=>serialize(
            data        = lt_resb
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_resb_json = '[]'.
        ENDIF.

        " --- Assemble nested JSON ---
        CONCATENATE
          '{'
            '"aufnr":"' lv_aufnr '",'
            '"header":' lv_header_json ','
            '"operations":' lv_ops_json ','
            '"components":' lv_resb_json
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
