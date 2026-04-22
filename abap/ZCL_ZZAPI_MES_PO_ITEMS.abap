CLASS zcl_zzapi_mes_po_items DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_po_items IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " PO line items — Strategy D ICF REST endpoint.
    " Returns PO items (EKPO) with delivery schedule (EKET).
    " Tables: EKPO, EKET.

    DATA: lv_method TYPE string,
          lv_ebeln  TYPE ebeln,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_ebeln  = server->request->get_form_field( 'ebeln' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_ebeln IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing ebeln parameter"}' ).
          RETURN.
        ENDIF.

        " --- Check PO exists ---
        DATA: lv_exists TYPE abap_bool.
        SELECT SINGLE @abap_true INTO @lv_exists FROM ekko WHERE ebeln = @lv_ebeln.
        IF lv_exists <> abap_true.
          server->response->set_status( code = 404 reason = 'Not Found' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"PO not found"}' ).
          RETURN.
        ENDIF.

        " --- PO items (EKPO) ---
        DATA: lt_ekpo TYPE TABLE OF ekpo,
              lv_ekpo_json TYPE string.
        SELECT * INTO TABLE lt_ekpo FROM ekpo
          WHERE ebeln = lv_ebeln
          ORDER BY ebelp.
        IF lines( lt_ekpo ) > 0.
          lv_ekpo_json = zz_cl_json=>serialize(
            data        = lt_ekpo
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_ekpo_json = '[]'.
        ENDIF.

        " --- Delivery schedule (EKET) ---
        DATA: lt_eket TYPE TABLE OF eket,
              lv_eket_json TYPE string.
        SELECT * INTO TABLE lt_eket FROM eket
          WHERE ebeln = lv_ebeln
          ORDER BY ebelp.
        IF lines( lt_eket ) > 0.
          lv_eket_json = zz_cl_json=>serialize(
            data        = lt_eket
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_eket_json = '[]'.
        ENDIF.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"ebeln":"' lv_ebeln '",'
            '"items":' lv_ekpo_json ','
            '"schedule":' lv_eket_json
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
