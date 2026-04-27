/**
 * SAP DDIC → human-readable field mapping definitions.
 *
 * Each entity (PO, Material, Stock, etc.) has a mapping table that the
 * transform engine uses to rename cryptic SAP field names to self-describing
 * English names and reformat dates from YYYYMMDD to ISO 8601.
 *
 * Unmapped fields are dropped in friendly output (available via
 * ?include=_source or ?format=raw).
 */

export interface FieldMapping {
  /** SAP DDIC field name (camelCase, as emitted by zz_cl_json) */
  sapName: string;
  /** Human-readable field name for the friendly API */
  friendlyName: string;
  /** If true, YYYYMMDD strings are converted to YYYY-MM-DD */
  isDate?: boolean;
}

export interface EntityMapping {
  /** Top-level object field mappings */
  fields: FieldMapping[];
  /** Nested array mappings, keyed by the array property name */
  nested?: Record<string, FieldMapping[]>;
}

/** Route path template → entity mapping key */
export const ROUTE_ENTITY_MAP: Record<string, string> = {
  "/po/:ebeln": "po",
  "/po/:ebeln/items": "poItems",
  "/prod-order/:aufnr": "prodOrder",
  "/material/:matnr": "material",
  "/stock/:matnr": "stock",
  "/routing/:matnr": "routing",
  "/work-center/:arbpl": "workCenter",
};

/** Shared operation mapping used by both prodOrder and routing */
const OPERATIONS_MAPPING: FieldMapping[] = [
  { sapName: "vornr", friendlyName: "operationNumber" },
  { sapName: "ltxa1", friendlyName: "operationDescription" },
  { sapName: "arbpl", friendlyName: "workCenterId" },
  { sapName: "vgwrt", friendlyName: "standardValue" },
  { sapName: "meinh", friendlyName: "timeUnit" },
];

export const ENTITY_MAPPINGS: Record<string, EntityMapping> = {
  po: {
    fields: [
      { sapName: "ebeln", friendlyName: "purchaseOrderNumber" },
      { sapName: "aedat", friendlyName: "createdAt", isDate: true },
      { sapName: "lifnr", friendlyName: "vendorNumber" },
      { sapName: "eindt", friendlyName: "deliveryDate", isDate: true },
    ],
  },

  poItems: {
    fields: [
      { sapName: "ebeln", friendlyName: "purchaseOrderNumber" },
    ],
    nested: {
      items: [
        { sapName: "ebelp", friendlyName: "itemNumber" },
        { sapName: "matnr", friendlyName: "materialNumber" },
        { sapName: "txz01", friendlyName: "description" },
        { sapName: "menge", friendlyName: "quantity" },
        { sapName: "meins", friendlyName: "unit" },
        { sapName: "netpr", friendlyName: "netPrice" },
        { sapName: "eindt", friendlyName: "deliveryDate", isDate: true },
        { sapName: "werks", friendlyName: "plant" },
        { sapName: "bukrs", friendlyName: "companyCode" },
        { sapName: "mtart", friendlyName: "materialType" },
        { sapName: "netwr", friendlyName: "netValue" },
        { sapName: "aedat", friendlyName: "changedDate", isDate: true },
        { sapName: "prdat", friendlyName: "priceDate", isDate: true },
        { sapName: "banfn", friendlyName: "purchaseRequisition" },
        { sapName: "statu", friendlyName: "status" },
      ],
      schedule: [
        { sapName: "ebelp", friendlyName: "itemNumber" },
        { sapName: "eindt", friendlyName: "deliveryDate", isDate: true },
        { sapName: "menge", friendlyName: "quantity" },
        { sapName: "bedat", friendlyName: "orderDate", isDate: true },
        { sapName: "wemng", friendlyName: "goodsReceiptQuantity" },
      ],
    },
  },

  material: {
    fields: [
      { sapName: "matnr", friendlyName: "materialNumber" },
      { sapName: "mtart", friendlyName: "materialType" },
      { sapName: "maktx", friendlyName: "description" },
      { sapName: "meins", friendlyName: "baseUnit" },
      { sapName: "werks", friendlyName: "plant" },
      { sapName: "dispo", friendlyName: "mrpController" },
      { sapName: "ersda", friendlyName: "createdDate", isDate: true },
      { sapName: "laeda", friendlyName: "lastChangedDate", isDate: true },
    ],
  },

  stock: {
    fields: [
      { sapName: "matnr", friendlyName: "materialNumber" },
      { sapName: "werks", friendlyName: "plant" },
    ],
    nested: {
      storageLocations: [
        { sapName: "lgort", friendlyName: "storageLocation" },
        { sapName: "charg", friendlyName: "batchNumber" },
        { sapName: "clabs", friendlyName: "unrestrictedStock" },
        { sapName: "insme", friendlyName: "inInspectionStock" },
        { sapName: "speme", friendlyName: "restrictedStock" },
        { sapName: "retme", friendlyName: "returnsStock" },
        { sapName: "avail_qty", friendlyName: "availableQuantity" },
        { sapName: "ersda", friendlyName: "createdDate", isDate: true },
      ],
      batches: [
        { sapName: "lgort", friendlyName: "storageLocation" },
        { sapName: "charg", friendlyName: "batchNumber" },
        { sapName: "clabs", friendlyName: "unrestrictedStock" },
        { sapName: "cinsm", friendlyName: "inInspectionStock" },
        { sapName: "cspem", friendlyName: "restrictedStock" },
        { sapName: "ersda", friendlyName: "createdDate", isDate: true },
      ],
    },
  },

  prodOrder: {
    fields: [
      { sapName: "aufnr", friendlyName: "productionOrderNumber" },
      { sapName: "auart", friendlyName: "orderType" },
      { sapName: "werks", friendlyName: "plant" },
      { sapName: "matnr", friendlyName: "materialNumber" },
      { sapName: "gamng", friendlyName: "totalQuantity" },
      { sapName: "gmein", friendlyName: "baseUnit" },
      { sapName: "gstrp", friendlyName: "scheduledStartDate", isDate: true },
      { sapName: "gltrp", friendlyName: "scheduledFinishDate", isDate: true },
    ],
    nested: {
      operations: OPERATIONS_MAPPING,
      components: [
        { sapName: "matnr", friendlyName: "materialNumber" },
        { sapName: "bdmenge", friendlyName: "requiredQuantity" },
        { sapName: "meins", friendlyName: "unit" },
        { sapName: "werks", friendlyName: "plant" },
        { sapName: "lgort", friendlyName: "storageLocation" },
      ],
    },
  },

  routing: {
    fields: [
      { sapName: "matnr", friendlyName: "materialNumber" },
      { sapName: "werks", friendlyName: "plant" },
      { sapName: "plnnr", friendlyName: "taskListGroup" },
      { sapName: "plnal", friendlyName: "groupCounter" },
    ],
    nested: {
      operations: OPERATIONS_MAPPING,
    },
  },

  workCenter: {
    fields: [
      { sapName: "arbpl", friendlyName: "workCenterId" },
      { sapName: "werks", friendlyName: "plant" },
      { sapName: "ktext", friendlyName: "description" },
      { sapName: "steus", friendlyName: "controlKey" },
      { sapName: "kapid", friendlyName: "capacityId" },
      { sapName: "kostl", friendlyName: "costCenter" },
    ],
    nested: {
      capacity: [
        { sapName: "kapid", friendlyName: "capacityId" },
        { sapName: "ktext", friendlyName: "description" },
        { sapName: "meinh", friendlyName: "timeUnit" },
      ],
      costCenters: [
        { sapName: "kostl", friendlyName: "costCenter" },
        { sapName: "lstar", friendlyName: "activityType" },
      ],
    },
  },
};

/** HATEOAS link templates per route.
 *  Values are path templates with {field} placeholders resolved from raw SAP data. */
export const ROUTE_LINKS: Record<string, Record<string, string>> = {
  "/po/:ebeln": {
    self: "/po/{ebeln}",
    items: "/po/{ebeln}/items",
  },
  "/po/:ebeln/items": {
    self: "/po/{ebeln}/items",
    purchaseOrder: "/po/{ebeln}",
  },
  "/prod-order/:aufnr": {
    self: "/prod-order/{aufnr}",
  },
  "/material/:matnr": {
    self: "/material/{matnr}",
    stock: "/stock/{matnr}",
  },
  "/stock/:matnr": {
    self: "/stock/{matnr}",
    material: "/material/{matnr}",
  },
  "/routing/:matnr": {
    self: "/routing/{matnr}",
    material: "/material/{matnr}",
  },
  "/work-center/:arbpl": {
    self: "/work-center/{arbpl}",
  },
};
