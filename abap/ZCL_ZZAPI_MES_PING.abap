CLASS zcl_zzapi_mes_ping DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_ping IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Minimal health-check handler — no DB access, safe for monitoring probes.
    " ICF-level Basic Auth only.

    DATA: lv_method TYPE string,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).

    CASE lv_method.
      WHEN 'GET'.
        CONCATENATE '{"ok":true,"sap_time":"' sy-datum sy-uzeit '"}'
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
