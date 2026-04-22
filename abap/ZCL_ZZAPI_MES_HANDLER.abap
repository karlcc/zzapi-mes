CLASS zcl_zzapi_mes_handler DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_handler IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " PO info handler — Strategy D ICF REST endpoint.
    " Reuses ZMES001 structure and ZZ_CL_JSON serializer to produce
    " identical JSON to the BSP page ZMES001.htm.

    DATA: lv_method TYPE string,
          lv_ebeln  TYPE ebeln,
          wa_mes001 TYPE zmes001,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_ebeln  = server->request->get_form_field( 'ebeln' ).

    CASE lv_method.
      WHEN 'GET'.
        SELECT SINGLE * INTO CORRESPONDING FIELDS OF wa_mes001
          FROM ekko WHERE ebeln = lv_ebeln.
        IF sy-subrc = 0.
          SELECT SINGLE eindt INTO wa_mes001-eindt
            FROM eket WHERE ebeln = lv_ebeln.
        ENDIF.

        IF sy-subrc = 0.
          lv_json = zz_cl_json=>serialize(
            data        = wa_mes001
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
          server->response->set_status( code = 200 reason = 'OK' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( lv_json ).
        ELSE.
          server->response->set_status( code = 404 reason = 'Not Found' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"PO not found"}' ).
        ENDIF.

      WHEN OTHERS.
        server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( '{"error":"Method not allowed"}' ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
