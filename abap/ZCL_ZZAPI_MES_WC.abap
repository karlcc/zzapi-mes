CLASS zcl_zzapi_mes_wc DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_wc IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Work center lookup — Strategy D ICF REST endpoint.
    " Returns work center details + capacity + cost center.
    " Tables: CRHD (header), CRCA (capacity), CRCO (cost center assignment).

    DATA: lv_method TYPE string,
          lv_arbpl  TYPE arbpl,
          lv_werks  TYPE werks_d,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_arbpl  = server->request->get_form_field( 'arbpl' ).
    lv_werks  = server->request->get_form_field( 'werks' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_arbpl IS INITIAL OR lv_werks IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing arbpl or werks parameter"}' ).
          RETURN.
        ENDIF.

        " --- Work center header (CRHD) ---
        DATA: ls_crhd TYPE crhd.
        SELECT SINGLE * INTO ls_crhd FROM crhd
          WHERE arbpl = lv_arbpl
            AND werks = lv_werks
            AND loekz = abap_false.
        IF sy-subrc <> 0.
          server->response->set_status( code = 404 reason = 'Not Found' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Work center not found"}' ).
          RETURN.
        ENDIF.

        DATA: lv_crhd_json TYPE string.
        lv_crhd_json = zz_cl_json=>serialize(
          data        = ls_crhd
          compress    = abap_true
          pretty_name = zz_cl_json=>pretty_mode-camel_case ).

        " --- Capacity (CRCA) ---
        DATA: lt_crca TYPE TABLE OF crca,
              lv_crca_json TYPE string.
        SELECT * INTO TABLE lt_crca FROM crca
          WHERE objid = ls_crhd-objid
            AND werks = lv_werks.
        IF lines( lt_crca ) > 0.
          lv_crca_json = zz_cl_json=>serialize(
            data        = lt_crca
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_crca_json = '[]'.
        ENDIF.

        " --- Cost center (CRCO) ---
        DATA: lt_crco TYPE TABLE OF crco,
              lv_crco_json TYPE string.
        SELECT * INTO TABLE lt_crco FROM crco
          WHERE objid = ls_crhd-objid
            AND werks = lv_werks
            AND loekz = abap_false.
        IF lines( lt_crco ) > 0.
          lv_crco_json = zz_cl_json=>serialize(
            data        = lt_crco
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_crco_json = '[]'.
        ENDIF.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"arbpl":"' lv_arbpl '",'
            '"werks":"' lv_werks '",'
            '"header":' lv_crhd_json ','
            '"capacity":' lv_crca_json ','
            '"costCenters":' lv_crco_json
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
