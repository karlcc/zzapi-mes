*--- Include ZIZZAPI_MES_EXTRACT_FORMS — JSON field extraction for SAP_BASIS 700
*   Used by: ZCL_ZZAPI_MES_CONF, ZCL_ZZAPI_MES_GR, ZCL_ZZAPI_MES_GI
*   No /UI2/CL_JSON available on 700; simple regex-based extraction.
*   Usage: PERFORM extract_field USING iv_json 'fieldname' CHANGING cv_value.

FORM extract_field USING iv_json TYPE string
                   iv_field TYPE string
          CHANGING cv_value TYPE string.

  DATA: lv_pattern TYPE string,
        lv_match   TYPE string,
        lo_regex   TYPE REF TO cl_abap_regex,
        lo_matcher TYPE REF TO cl_abap_matcher.

  " Pattern matches "field":"value" or "field": value (number/bool)
  CONCATENATE '"' iv_field '"\s*:\s*"?([^",:}\]]+)"?'
    INTO lv_pattern.

  CREATE OBJECT lo_regex
    EXPORTING
      pattern = lv_pattern
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

ENDFORM.
