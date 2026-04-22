CLASS zcl_zzapi_mes_routing DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_routing IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    " Routing / recipe lookup — Strategy D ICF REST endpoint.
    " Returns operation sequence + standard times for a material at a plant.
    " Tables: MAPL (material→task list), PLKO (header), PLPO (operations).

    DATA: lv_method TYPE string,
          lv_matnr  TYPE matnr,
          lv_werks  TYPE werks_d,
          lv_json   TYPE string.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_matnr  = server->request->get_form_field( 'matnr' ).
    lv_werks  = server->request->get_form_field( 'werks' ).

    CASE lv_method.
      WHEN 'GET'.
        IF lv_matnr IS INITIAL OR lv_werks IS INITIAL.
          server->response->set_status( code = 400 reason = 'Bad Request' ).
          server->response->set_content_type( 'application/json' ).
          server->response->set_cdata( '{"error":"Missing matnr or werks parameter"}' ).
          RETURN.
        ENDIF.

        " --- Find task list assignment (MAPL) ---
        DATA: ls_mapl TYPE mapl.
        SELECT SINGLE * INTO ls_mapl FROM mapl
          WHERE matnr = lv_matnr
            AND werks = lv_werks
            AND plnty = 'R'          " Routing
            AND loekz = abap_false
            AND plnal = '01'.        " Default alternative
        IF sy-subrc <> 0.
          " Try any non-deleted routing
          SELECT SINGLE * INTO ls_mapl FROM mapl
            WHERE matnr = lv_matnr
              AND werks = lv_werks
              AND plnty = 'R'
              AND loekz = abap_false.
          IF sy-subrc <> 0.
            server->response->set_status( code = 404 reason = 'Not Found' ).
            server->response->set_content_type( 'application/json' ).
            server->response->set_cdata( '{"error":"No routing found for material/plant"}' ).
            RETURN.
          ENDIF.
        ENDIF.

        " --- Task list header (PLKO) ---
        DATA: ls_plko TYPE plko,
              lv_plko_json TYPE string.
        SELECT SINGLE * INTO ls_plko FROM plko
          WHERE plnty = ls_mapl-plnty
            AND plnnr = ls_mapl-plnnr
            AND plnal = ls_mapl-plnal
            AND loekz = abap_false.
        IF sy-subrc = 0.
          lv_plko_json = zz_cl_json=>serialize(
            data        = ls_plko
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_plko_json = 'null'.
        ENDIF.

        " --- Operations (PLPO) ---
        DATA: lt_plpo TYPE TABLE OF plpo,
              lv_ops_json TYPE string.
        SELECT * INTO TABLE lt_plpo FROM plpo
          WHERE plnty = ls_mapl-plnty
            AND plnnr = ls_mapl-plnnr
            AND plnal = ls_mapl-plnal
            AND loekz = abap_false
          ORDER BY vornr.
        IF lines( lt_plpo ) > 0.
          lv_ops_json = zz_cl_json=>serialize(
            data        = lt_plpo
            compress    = abap_true
            pretty_name = zz_cl_json=>pretty_mode-camel_case ).
        ELSE.
          lv_ops_json = '[]'.
        ENDIF.

        " --- Assemble JSON ---
        CONCATENATE
          '{'
            '"matnr":"' lv_matnr '",'
            '"werks":"' lv_werks '",'
            '"plnnr":"' ls_mapl-plnnr '",'
            '"plnal":"' ls_mapl-plnal '",'
            '"header":' lv_plko_json ','
            '"operations":' lv_ops_json
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
