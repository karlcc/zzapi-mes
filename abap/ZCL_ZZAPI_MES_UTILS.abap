CLASS zcl_zzapi_mes_utils DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS: extract_field
      IMPORTING iv_json  TYPE string
                iv_field TYPE string
      CHANGING  cv_value TYPE string.
ENDCLASS.

CLASS zcl_zzapi_mes_utils IMPLEMENTATION.
  METHOD extract_field.
    " Simple regex-based JSON field extraction (SAP_BASIS 700 — no /UI2/CL_JSON)
    " Matches "field":"value" or "field": value (number/bool)

    DATA: lv_pattern TYPE string,
          lv_match   TYPE string,
          lo_regex   TYPE REF TO cl_abap_regex,
          lo_matcher TYPE REF TO cl_abap_matcher.

    CONCATENATE '"' iv_field '"\s*:\s*"?([^",:}\]]+)"?'
      INTO lv_pattern.

    CREATE OBJECT lo_regex
      EXPORTING
        pattern     = lv_pattern
        ignore_case = abap_true.

    CREATE OBJECT lo_matcher
      EXPORTING
        regex = lo_regex
        text  = iv_json.

    IF lo_matcher->find_next( ) = abap_true.
      lv_match = lo_matcher->get_submatch( 1 ).
      " Trim leading/trailing whitespace and quotes
      SHIFT lv_match LEFT DELETING LEADING space.
      SHIFT lv_match RIGHT DELETING TRAILING space.
      SHIFT lv_match LEFT DELETING LEADING '"'.
      SHIFT lv_match RIGHT DELETING TRAILING '"'.
      cv_value = lv_match.
    ELSE.
      CLEAR cv_value.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
