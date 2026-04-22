CLASS zcl_zzapi_mes_ping DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_ping IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Minimal health-check handler.
    " Returns { "ok": true, "sap_time": "YYYYMMDDHHMMSS" }
    " No auth checks beyond ICF-level Basic Auth.
    " No DB access — safe for monitoring probes.

    DATA: lv_json TYPE string.

    CONCATENATE '{"ok":true,"sap_time":"' sy-datum sy-uzeit '"}'
      INTO lv_json.

    server->response->set_status( code = 200 reason = 'OK' ).
    server->response->set_content_type( 'application/json' ).
    server->response->set_cdata( lv_json ).
  ENDMETHOD.
ENDCLASS.
