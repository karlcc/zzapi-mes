CLASS zcl_zzapi_mes_utils DEFINITION
  PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS: extract_field
      IMPORTING iv_json  TYPE string
                iv_field TYPE string
      CHANGING  cv_value TYPE string.

    CLASS-METHODS: is_valid_id
      IMPORTING iv_value TYPE string
      RETURNING VALUE(rv_valid) TYPE abap_bool.
ENDCLASS.

CLASS zcl_zzapi_mes_utils IMPLEMENTATION.
  METHOD extract_field.
    " JSON field extraction (SAP_BASIS 700 — no /UI2/CL_JSON)
    " Handles escaped quotes (\") inside string values.
    " Matches "field":"value" or "field": number/bool/null
    " Only matches top-level fields (depth 0 inside root object).
    " Size-limited: rejects JSON > 1 MB to prevent O(N*M) regex scan.

    CONSTANTS: lc_max_json_size TYPE i VALUE 1048576.  " 1 MB

    DATA: lv_pattern   TYPE string,
          lv_match     TYPE string,
          lo_regex     TYPE REF TO cl_abap_regex,
          lo_matcher   TYPE REF TO cl_abap_matcher,
          lv_offset    TYPE i,
          lv_prefix    TYPE string,
          lv_open      TYPE i,
          lv_close     TYPE i,
          lv_depth     TYPE i,
          lv_is_string TYPE abap_bool.

    " Size limit: reject oversized JSON to prevent O(N*M) regex scan
    IF strlen( iv_json ) > lc_max_json_size.
      CLEAR cv_value.
      RETURN.
    ENDIF.

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

    " Find the first match at top-level depth (depth 0 inside root object).
    " Without depth check, nested fields like {"child":{"field":"x"}}
    " would incorrectly match the inner "field" if it appears first.
    WHILE lo_matcher->find_next( ) = abap_true.
      lv_offset = lo_matcher->get_offset( ).
      " Count brace depth before match position to verify top-level.
      " Depth 0 = before the opening { of root object,
      " depth 1 = inside the root object (where top-level fields live).
      lv_prefix = iv_json(lv_offset).
      FIND ALL OCCURRENCES OF '{' IN lv_prefix MATCH COUNT lv_open.
      FIND ALL OCCURRENCES OF '}' IN lv_prefix MATCH COUNT lv_close.
      lv_depth = lv_open - lv_close.
      " Top-level fields are at depth 1 (inside the root object but not
      " inside any nested object). Skip matches at depth > 1.
      IF lv_depth = 1.
        " Submatch 1 = string value (with possible escapes),
        " submatch 2 = unquoted value (number/bool/null).
        lv_match = lo_matcher->get_submatch( 1 ).
        IF lv_match IS NOT INITIAL.
          lv_is_string = abap_true.
        ELSE.
          lv_match = lo_matcher->get_submatch( 2 ).
          lv_is_string = abap_false.
        ENDIF.
        " Trim leading/trailing whitespace
        SHIFT lv_match LEFT DELETING LEADING space.
        SHIFT lv_match RIGHT DELETING TRAILING space.
        " Unescape JSON escapes ONLY for string values.
        " Applying unescape to unquoted values (numbers/bools) corrupts
        " legitimate backslash or quote characters in the raw value.
        IF lv_is_string = abap_true.
          " Unescape JSON escapes: \" → ", \\ → \
          " (SAP_BASIS 700: no REPLACE ALL OCCURRENCES OF REGEX,
          "  so use two-pass string replacement)
          REPLACE ALL OCCURRENCES OF `\"` IN lv_match WITH '"'.
          REPLACE ALL OCCURRENCES OF `\\` IN lv_match WITH `\`.
        ENDIF.
        cv_value = lv_match.
        RETURN.
      ENDIF.
      " Not at top level — continue searching for next match
    ENDWHILE.

    " No top-level match found
    CLEAR cv_value.
  ENDMETHOD.

  METHOD is_valid_id.
    " Validate that a query parameter value contains only safe characters.
    " Matches hub validateParam: alphanumeric, hyphens, underscores.
    " Prevents injection and invalid requests from reaching SAP SELECT.
    IF iv_value IS INITIAL.
      rv_valid = abap_true.  " Empty is handled by IS INITIAL checks
      RETURN.
    ENDIF.
    DATA: lv_len  TYPE i,
          lv_pos  TYPE i,
          lv_char TYPE c.
    lv_len = strlen( iv_value ).
    DO lv_len TIMES.
      lv_pos = sy-index - 1.
      lv_char = iv_value+lv_pos(1).
      " Alphanumeric (A-Z, a-z, 0-9), hyphen, underscore only
      IF NOT ( ( lv_char >= 'A' AND lv_char <= 'Z' )
            OR ( lv_char >= 'a' AND lv_char <= 'z' )
            OR ( lv_char >= '0' AND lv_char <= '9' )
            OR lv_char = '-'
            OR lv_char = '_' ).
        rv_valid = abap_false.
        RETURN.
      ENDIF.
    ENDDO.
    rv_valid = abap_true.
  ENDMETHOD.
ENDCLASS.
