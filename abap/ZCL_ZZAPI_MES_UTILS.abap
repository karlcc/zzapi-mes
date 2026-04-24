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
    " JSON field extraction (SAP_BASIS 700 — no /UI2/CL_JSON)
    " Handles escaped quotes (\") inside string values.
    " Matches "field":"value" or "field": number/bool/null

    DATA: lv_pattern TYPE string,
          lv_match   TYPE string,
          lo_regex   TYPE REF TO cl_abap_regex,
          lo_matcher TYPE REF TO cl_abap_matcher.

    " Regex explanation (SAP_BASIS 700 — no PCRE lookbehind):
    "   "field"\s*:\s*        — key + colon
    "   (?:                  — non-capturing group for value alternatives:
    "     "((?:[^"\\]|\\.)*) — string: chars that are not " or \, OR any \. pair
    "     |([^",:}\]\s]+)    — unquoted: non-delimiter run (number/bool/null)
    "   )
    CONCATENATE '"' iv_field '"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|([^",:}\]\s]+))'
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
      " Submatch 1 = string value (with possible escapes), submatch 2 = unquoted
      lv_match = lo_matcher->get_submatch( 1 ).
      IF lv_match IS INITIAL.
        lv_match = lo_matcher->get_submatch( 2 ).
      ENDIF.
      " Trim leading/trailing whitespace
      SHIFT lv_match LEFT DELETING LEADING space.
      SHIFT lv_match RIGHT DELETING TRAILING space.
      " Unescape JSON escapes: \" → ", \\ → \
      " (SAP_BASIS 700: no REPLACE ALL OCCURRENCES OF REGEX in cl_abap_regex,
      "  so use two-pass string replacement)
      REPLACE ALL OCCURRENCES OF `\"` IN lv_match WITH '"'.
      REPLACE ALL OCCURRENCES OF `\\` IN lv_match WITH `\`.
      cv_value = lv_match.
    ELSE.
      CLEAR cv_value.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
