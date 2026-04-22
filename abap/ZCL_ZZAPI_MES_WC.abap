CLASS zcl_zzapi_mes_wc DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_wc IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Work center lookup — Strategy D ICF REST endpoint.
    " Returns work center details including capacity and cost center.
    " Tables: CRHD (header), CRTX (description), CRCA (capacity assignment).

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
            AND werks = lv_werks.
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

        " --- Work center text (CRTX) ---
        DATA: ls_crtx TYPE crtx.
        SELECT SINGLE * INTO ls_crtx FROM crtx
          WHERE objty = ls_crhd-objty
            AND objid = ls_crhd-objid
            AND spras = sy-langu.
        DATA: lv_ktext TYPE string.
        lv_ktext = ls_crtx-ktext.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"arbpl":"' lv_arbpl '",'
            '"werks":"' lv_werks '",'
            '"ktext":"' lv_ktext '",'
            '"detail":' lv_crhd_json
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
