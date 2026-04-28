import { z } from "zod";

const PingResponse = z
  .object({ ok: z.boolean(), sap_time: z.string().regex(/^[0-9]{14}$/) })
  .passthrough();
const ErrorResponse = z
  .object({
    error: z.string(),
    description: z.string().optional(),
    original_status: z.number().int().optional(),
  })
  .passthrough();
const PoResponse = z
  .object({
    ebeln: z.string().max(10),
    aedat: z.string().regex(/^[0-9]{8}$/),
    lifnr: z.string().max(10),
    eindt: z.string().regex(/^[0-9]{8}$/),
  })
  .passthrough();
const TokenResponse = z
  .object({ token: z.string(), expires_in: z.number().int() })
  .passthrough();
const PoFriendlyData = z
  .object({
    purchaseOrderNumber: z.string().max(10),
    createdAt: z.string(),
    vendorNumber: z.string().max(10),
    deliveryDate: z.string(),
  })
  .passthrough();
const PoFriendlyResponse = z
  .object({
    data: PoFriendlyData,
    _links: z
      .object({ self: z.string(), items: z.string() })
      .partial()
      .passthrough(),
    _source: PoResponse.optional(),
  })
  .passthrough();
const ProdOrderOperation = z
  .object({
    vornr: z.string().max(4),
    ltxa1: z.string(),
    arbpl: z.string().max(8).optional(),
    vgwrt: z.number().optional(),
  })
  .passthrough();
const ProdOrderComponent = z
  .object({
    matnr: z.string().max(18),
    bdmenge: z.number(),
    meins: z.string().max(3).optional(),
    werks: z.string().max(4).optional(),
  })
  .passthrough();
const ProdOrderResponse = z
  .object({
    aufnr: z.string().max(12),
    auart: z.string().max(4),
    werks: z.string().max(4),
    matnr: z.string().max(18),
    gamng: z.number(),
    gmein: z.string().max(3).optional(),
    gstrp: z.string().regex(/^[0-9]{8}$/),
    gltrp: z.string().regex(/^[0-9]{8}$/),
    operations: z.array(ProdOrderOperation).optional(),
    components: z.array(ProdOrderComponent).optional(),
  })
  .passthrough();
const MaterialResponse = z
  .object({
    matnr: z.string().max(18),
    mtart: z.string().max(4),
    meins: z.string().max(3),
    maktx: z.string().optional(),
    werks: z.string().max(4).optional(),
    dispo: z.string().max(3).optional(),
  })
  .passthrough();
const StockItem = z
  .object({
    lgort: z.string().max(4),
    charg: z.string().max(10).optional(),
    clabs: z.number(),
    avail_qty: z.number().optional(),
  })
  .passthrough();
const StockResponse = z
  .object({
    matnr: z.string().max(18),
    werks: z.string().max(4),
    items: z.array(StockItem).optional(),
  })
  .passthrough();
const PoItem = z
  .object({
    ebelp: z.string().max(5),
    matnr: z.string().max(18),
    txz01: z.string().optional(),
    menge: z.number(),
    meins: z.string().max(3),
    netpr: z.number().optional(),
    eindt: z
      .string()
      .regex(/^[0-9]{8}$/)
      .optional(),
  })
  .passthrough();
const PoItemsResponse = z
  .object({ ebeln: z.string().max(10), items: z.array(PoItem) })
  .passthrough();
const RoutingOperationSchema = z
  .object({
    vornr: z.string().max(4),
    ltxa1: z.string(),
    arbpl: z.string().max(8).optional(),
    vgwrt: z.number().optional(),
    meinh: z.string().max(3).optional(),
  })
  .passthrough();
const RoutingResponse = z
  .object({
    matnr: z.string().max(18),
    werks: z.string().max(4),
    plnnr: z.string().max(8),
    plnal: z.string().max(2).optional(),
    operations: z.array(RoutingOperationSchema),
  })
  .passthrough();
const WorkCenterResponse = z
  .object({
    arbpl: z.string().max(8),
    werks: z.string().max(4),
    ktext: z.string().optional(),
    steus: z.string().max(4).optional(),
    kapid: z.string().max(8).optional(),
    kostl: z.string().max(10).optional(),
  })
  .passthrough();
const ProdOrderFriendlyData = z
  .object({
    productionOrderNumber: z.string().max(12),
    orderType: z.string().max(4),
    plant: z.string().max(4),
    materialNumber: z.string().max(18),
    totalQuantity: z.number(),
    baseUnit: z.string().max(3).optional(),
    scheduledStartDate: z.string(),
    scheduledFinishDate: z.string(),
    operations: z
      .array(
        z
          .object({
            operationNumber: z.string(),
            operationDescription: z.string(),
            workCenterId: z.string(),
            standardValue: z.number(),
          })
          .partial()
          .passthrough()
      )
      .optional(),
    components: z
      .array(
        z
          .object({
            materialNumber: z.string(),
            requiredQuantity: z.number(),
            unit: z.string(),
            plant: z.string(),
            storageLocation: z.string(),
          })
          .partial()
          .passthrough()
      )
      .optional(),
  })
  .passthrough();
const ProdOrderFriendlyResponse = z
  .object({
    data: ProdOrderFriendlyData,
    _links: z.object({ self: z.string() }).partial().passthrough(),
    _source: ProdOrderResponse.optional(),
  })
  .passthrough();
const MaterialFriendlyData = z
  .object({
    materialNumber: z.string().max(18),
    materialType: z.string().max(4),
    description: z.string().optional(),
    baseUnit: z.string().max(3),
    plant: z.string().max(4).optional(),
    mrpController: z.string().max(3).optional(),
  })
  .passthrough();
const MaterialFriendlyResponse = z
  .object({
    data: MaterialFriendlyData,
    _links: z
      .object({ self: z.string(), stock: z.string() })
      .partial()
      .passthrough(),
    _source: MaterialResponse.optional(),
  })
  .passthrough();
const StockFriendlyData = z
  .object({
    materialNumber: z.string().max(18),
    plant: z.string().max(4),
    storageLocations: z
      .array(
        z
          .object({
            storageLocation: z.string(),
            batchNumber: z.string(),
            unrestrictedStock: z.number(),
            availableQuantity: z.number(),
            createdDate: z.string(),
          })
          .partial()
          .passthrough()
      )
      .optional(),
  })
  .passthrough();
const StockFriendlyResponse = z
  .object({
    data: StockFriendlyData,
    _links: z
      .object({ self: z.string(), material: z.string() })
      .partial()
      .passthrough(),
    _source: StockResponse.optional(),
  })
  .passthrough();
const PoItemFriendlyData = z
  .object({
    itemNumber: z.string(),
    materialNumber: z.string(),
    description: z.string(),
    quantity: z.number(),
    unit: z.string(),
    netPrice: z.number(),
    deliveryDate: z.string(),
    plant: z.string().max(4),
    companyCode: z.string().max(4),
    materialType: z.string().max(4),
    netValue: z.number(),
    changedDate: z.string(),
    priceDate: z.string(),
    purchaseRequisition: z.string().max(10),
    status: z.string(),
  })
  .partial()
  .passthrough();
const PoItemScheduleFriendlyData = z
  .object({
    itemNumber: z.string(),
    deliveryDate: z.string(),
    quantity: z.number(),
    orderDate: z.string(),
    goodsReceiptQuantity: z.number(),
  })
  .partial()
  .passthrough();
const PoItemsFriendlyResponse = z
  .object({
    data: z
      .object({
        purchaseOrderNumber: z.string(),
        items: z.array(PoItemFriendlyData),
        schedule: z.array(PoItemScheduleFriendlyData),
      })
      .partial()
      .passthrough(),
    _links: z
      .object({ self: z.string(), purchaseOrder: z.string() })
      .partial()
      .passthrough(),
    _source: PoItemsResponse.optional(),
  })
  .passthrough();
const RoutingFriendlyData = z
  .object({
    materialNumber: z.string().max(18),
    plant: z.string().max(4),
    taskListGroup: z.string().max(8),
    groupCounter: z.string().max(2).optional(),
    operations: z.array(
      z
        .object({
          operationNumber: z.string(),
          operationDescription: z.string(),
          workCenterId: z.string(),
          standardValue: z.number(),
          timeUnit: z.string(),
        })
        .partial()
        .passthrough()
    ),
  })
  .passthrough();
const RoutingFriendlyResponse = z
  .object({
    data: RoutingFriendlyData,
    _links: z
      .object({ self: z.string(), material: z.string() })
      .partial()
      .passthrough(),
    _source: RoutingResponse.optional(),
  })
  .passthrough();
const WorkCenterFriendlyData = z
  .object({
    workCenterId: z.string().max(8),
    plant: z.string().max(4),
    description: z.string().optional(),
    controlKey: z.string().max(4).optional(),
    capacityId: z.string().max(8).optional(),
    costCenter: z.string().max(10).optional(),
  })
  .passthrough();
const WorkCenterFriendlyResponse = z
  .object({
    data: WorkCenterFriendlyData,
    _links: z.object({ self: z.string() }).partial().passthrough(),
    _source: WorkCenterResponse.optional(),
  })
  .passthrough();
const ConfirmationRequest = z.object({
  orderid: z.string().min(1).max(12),
  operation: z.string().min(1).max(4),
  yield: z.number().gte(1),
  scrap: z.number().gte(0).optional(),
  work_actual: z.number().gte(0).optional(),
  postg_date: z
    .string()
    .regex(/^[0-9]{8}$/)
    .optional(),
})
  .strict();
const ConfirmationResponse = z
  .object({
    orderid: z.string(),
    operation: z.string(),
    yield: z.number(),
    scrap: z.number(),
    confNo: z.string().optional(),
    confCnt: z.string().optional(),
    status: z.string(),
    message: z.string().optional(),
  })
  .passthrough();
const GoodsReceiptRequest = z.object({
  ebeln: z.string().min(1).max(10),
  ebelp: z.string().min(1).max(5),
  menge: z.number().gte(1),
  werks: z.string().min(1).max(4),
  lgort: z.string().min(1).max(4),
  budat: z
    .string()
    .regex(/^[0-9]{8}$/)
    .optional(),
  charg: z.string().max(10).optional(),
})
  .strict();
const GoodsReceiptResponse = z
  .object({
    ebeln: z.string(),
    ebelp: z.string(),
    menge: z.number(),
    materialDocument: z.string().optional(),
    documentYear: z.string().optional(),
    status: z.string(),
    message: z.string().optional(),
  })
  .passthrough();
const GoodsIssueRequest = z.object({
  orderid: z.string().min(1).max(12),
  matnr: z.string().min(1).max(18),
  menge: z.number().gte(1),
  werks: z.string().min(1).max(4),
  lgort: z.string().min(1).max(4),
  budat: z
    .string()
    .regex(/^[0-9]{8}$/)
    .optional(),
  charg: z.string().max(10).optional(),
})
  .strict();
const GoodsIssueResponse = z
  .object({
    orderid: z.string(),
    matnr: z.string(),
    menge: z.number(),
    materialDocument: z.string().optional(),
    documentYear: z.string().optional(),
    status: z.string(),
    message: z.string().optional(),
  })
  .passthrough();
const HealthzResponse = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    sap: z.string().optional(),
  })
  .passthrough();
const FriendlyEnvelope = z
  .object({
    data: z.object({}).partial().passthrough(),
    _links: z.record(z.string()),
    _source: z.object({}).partial().passthrough().optional(),
  })
  .passthrough();

export const schemas = {
  PingResponse,
  ErrorResponse,
  PoResponse,
  TokenResponse,
  PoFriendlyData,
  PoFriendlyResponse,
  ProdOrderOperation,
  ProdOrderComponent,
  ProdOrderResponse,
  MaterialResponse,
  StockItem,
  StockResponse,
  PoItem,
  PoItemsResponse,
  RoutingOperationSchema,
  RoutingResponse,
  WorkCenterResponse,
  ProdOrderFriendlyData,
  ProdOrderFriendlyResponse,
  MaterialFriendlyData,
  MaterialFriendlyResponse,
  StockFriendlyData,
  StockFriendlyResponse,
  PoItemFriendlyData,
  PoItemScheduleFriendlyData,
  PoItemsFriendlyResponse,
  RoutingFriendlyData,
  RoutingFriendlyResponse,
  WorkCenterFriendlyData,
  WorkCenterFriendlyResponse,
  ConfirmationRequest,
  ConfirmationResponse,
  GoodsReceiptRequest,
  GoodsReceiptResponse,
  GoodsIssueRequest,
  GoodsIssueResponse,
  HealthzResponse,
  FriendlyEnvelope,
};

// Re-export with Schema suffix for consumers that depend on the XxxSchema naming convention
export const PingResponseSchema = PingResponse;
export const PoResponseSchema = PoResponse;
export const ErrorResponseSchema = ErrorResponse;
export const ProdOrderResponseSchema = ProdOrderResponse;
export const MaterialResponseSchema = MaterialResponse;
export const StockResponseSchema = StockResponse;
export const PoItemsResponseSchema = PoItemsResponse;
export const RoutingResponseSchema = RoutingResponse;
export const WorkCenterResponseSchema = WorkCenterResponse;
export const ConfirmationRequestSchema = ConfirmationRequest;
export const ConfirmationResponseSchema = ConfirmationResponse;
export const GoodsReceiptRequestSchema = GoodsReceiptRequest;
export const GoodsReceiptResponseSchema = GoodsReceiptResponse;
export const GoodsIssueRequestSchema = GoodsIssueRequest;
export const GoodsIssueResponseSchema = GoodsIssueResponse;
export const TokenResponseSchema = TokenResponse;
export const HealthzResponseSchema = HealthzResponse;
