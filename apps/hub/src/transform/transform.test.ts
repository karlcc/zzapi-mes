import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  transformResponse,
  transformEntity,
  parseTransformOpts,
} from "../transform/transform.js";
import { ENTITY_MAPPINGS } from "../transform/mappings.js";

describe("transformEntity", () => {
  it("maps PO header fields and reformats dates", () => {
    const raw = {
      ebeln: "3010000608",
      aedat: "20170306",
      lifnr: "0000500340",
      eindt: "20170630",
    };
    const mapping = ENTITY_MAPPINGS["po"]!;
    const result = transformEntity(raw, mapping);
    assert.deepEqual(result, {
      purchaseOrderNumber: "3010000608",
      createdAt: "2017-03-06",
      vendorNumber: "0000500340",
      deliveryDate: "2017-06-30",
    });
  });

  it("maps PO header fields with numeric dates from SAP", () => {
    const raw = {
      ebeln: "3010000608",
      aedat: 20170306,
      lifnr: "0000500340",
      eindt: 20170630,
    };
    const mapping = ENTITY_MAPPINGS["po"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.purchaseOrderNumber, "3010000608");
    assert.equal(result.createdAt, "2017-03-06");
    assert.equal(result.vendorNumber, "0000500340");
    assert.equal(result.deliveryDate, "2017-06-30");
  });

  it("maps material fields", () => {
    const raw = {
      matnr: "000000000100000001",
      mtart: "Z010",
      maktx: "ATOS Software Upgr51",
      meins: "EA",
    };
    const mapping = ENTITY_MAPPINGS["material"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.materialNumber, "000000000100000001");
    assert.equal(result.materialType, "Z010");
    assert.equal(result.description, "ATOS Software Upgr51");
    assert.equal(result.baseUnit, "EA");
  });

  it("maps nested arrays (stock storageLocations)", () => {
    const raw = {
      matnr: "10000001",
      werks: "1000",
      storageLocations: [
        { lgort: "1G9Z", clabs: 36, avail_qty: 30, ersda: "20090320" },
        { lgort: "2G9Z", clabs: 10 },
      ],
    };
    const mapping = ENTITY_MAPPINGS["stock"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.materialNumber, "10000001");
    assert.equal(result.plant, "1000");
    const locs = result.storageLocations as Array<Record<string, unknown>>;
    assert.equal(locs[0]!.storageLocation, "1G9Z");
    assert.equal(locs[0]!.unrestrictedStock, 36);
    assert.equal(locs[0]!.availableQuantity, 30);
    assert.equal(locs[0]!.createdDate, "2009-03-20");
    assert.equal(locs[1]!.storageLocation, "2G9Z");
    assert.equal(locs[1]!.unrestrictedStock, 10);
  });

  it("maps prod order with nested operations and components", () => {
    const raw = {
      aufnr: "000001001234",
      auart: "PP01",
      werks: "1000",
      matnr: "000000000100000001",
      gamng: 100,
      gmein: "EA",
      gstrp: "20240101",
      gltrp: "20240115",
      operations: [
        { vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 },
      ],
      components: [
        { matnr: "10000001", bdmenge: 5, meins: "EA", werks: "1000", lgort: "0001" },
      ],
    };
    const mapping = ENTITY_MAPPINGS["prodOrder"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.productionOrderNumber, "000001001234");
    assert.equal(result.orderType, "PP01");
    assert.equal(result.scheduledStartDate, "2024-01-01");
    assert.equal(result.scheduledFinishDate, "2024-01-15");
    const ops = result.operations as Array<Record<string, unknown>>;
    assert.equal(ops[0]!.operationNumber, "0010");
    assert.equal(ops[0]!.operationDescription, "Turning");
    assert.equal(ops[0]!.workCenterId, "TURN1");
    const comps = result.components as Array<Record<string, unknown>>;
    assert.equal(comps[0]!.materialNumber, "10000001");
    assert.equal(comps[0]!.requiredQuantity, 5);
    assert.equal(comps[0]!.storageLocation, "0001");
  });

  it("drops unmapped fields in friendly output", () => {
    const raw = {
      ebeln: "3010000608",
      aedat: "20170306",
      lifnr: "0000500340",
      eindt: "20170630",
      extraField: "hello",
      anotherOne: 42,
      mandt: "200",
      bukrs: "1000",
    };
    const mapping = ENTITY_MAPPINGS["po"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.purchaseOrderNumber, "3010000608");
    assert.equal(result.createdAt, "2017-03-06");
    // Unmapped fields should NOT appear
    assert.equal("extraField" in result, false);
    assert.equal("anotherOne" in result, false);
    assert.equal("mandt" in result, false);
    assert.equal("bukrs" in result, false);
  });

  it("does not reformat non-date values", () => {
    const raw = { aufnr: "1000000", auart: "PP01" };
    const mapping = ENTITY_MAPPINGS["prodOrder"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.productionOrderNumber, "1000000");
    assert.equal(result.orderType, "PP01");
  });

  it("maps work center fields", () => {
    const raw = {
      arbpl: "TURN1",
      werks: "1000",
      ktext: "Turning Center 1",
      steus: "PP01",
      kapid: 500001,
      kostl: "C1000",
    };
    const mapping = ENTITY_MAPPINGS["workCenter"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.workCenterId, "TURN1");
    assert.equal(result.plant, "1000");
    assert.equal(result.description, "Turning Center 1");
    assert.equal(result.controlKey, "PP01");
    assert.equal(result.capacityId, 500001);
    assert.equal(result.costCenter, "C1000");
  });

  it("maps routing fields with nested operations", () => {
    const raw = {
      matnr: "100920000",
      werks: "1000",
      plnnr: "500001",
      plnal: "01",
      operations: [
        { vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5, meinh: "H" },
      ],
    };
    const mapping = ENTITY_MAPPINGS["routing"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.materialNumber, "100920000");
    assert.equal(result.taskListGroup, "500001");
    assert.equal(result.groupCounter, "01");
    const ops = result.operations as Array<Record<string, unknown>>;
    assert.equal(ops[0]!.operationNumber, "0010");
    assert.equal(ops[0]!.timeUnit, "H");
  });

  it("maps PO items with extended fields and numeric dates", () => {
    const raw = {
      ebeln: "3010000608",
      items: [
        {
          ebelp: 20,
          matnr: "000000000201000225",
          txz01: "Prep.Trigger Probe P.IP.CR",
          menge: 2,
          meins: "EA",
          netpr: 56666,
          eindt: 20170630,
          werks: "1000",
          bukrs: "1000",
          mtart: "Z020",
          netwr: 113332,
          aedat: 20180209,
          prdat: 20170306,
          banfn: "1900007474",
          statu: "F",
          mandt: "200",
          ematn: "000000000201000225",
          bpumz: 1,
        },
      ],
      schedule: [
        {
          ebelp: 20,
          eindt: 20170630,
          menge: 2,
          bedat: 20170306,
          wemng: 2,
          etenr: 1,
          slfdt: 20170630,
        },
      ],
    };
    const mapping = ENTITY_MAPPINGS["poItems"]!;
    const result = transformEntity(raw, mapping);
    assert.equal(result.purchaseOrderNumber, "3010000608");

    const items = result.items as Array<Record<string, unknown>>;
    assert.equal(items[0]!.itemNumber, 20);
    assert.equal(items[0]!.materialNumber, "000000000201000225");
    assert.equal(items[0]!.description, "Prep.Trigger Probe P.IP.CR");
    assert.equal(items[0]!.quantity, 2);
    assert.equal(items[0]!.unit, "EA");
    assert.equal(items[0]!.netPrice, 56666);
    assert.equal(items[0]!.deliveryDate, "2017-06-30");
    assert.equal(items[0]!.plant, "1000");
    assert.equal(items[0]!.companyCode, "1000");
    assert.equal(items[0]!.materialType, "Z020");
    assert.equal(items[0]!.netValue, 113332);
    assert.equal(items[0]!.changedDate, "2018-02-09");
    assert.equal(items[0]!.priceDate, "2017-03-06");
    assert.equal(items[0]!.purchaseRequisition, "1900007474");
    assert.equal(items[0]!.status, "F");
    // Unmapped fields dropped
    assert.equal("mandt" in items[0]!, false);
    assert.equal("ematn" in items[0]!, false);
    assert.equal("bpumz" in items[0]!, false);

    const sched = result.schedule as Array<Record<string, unknown>>;
    assert.equal(sched[0]!.itemNumber, 20);
    assert.equal(sched[0]!.deliveryDate, "2017-06-30");
    assert.equal(sched[0]!.quantity, 2);
    assert.equal(sched[0]!.orderDate, "2017-03-06");
    assert.equal(sched[0]!.goodsReceiptQuantity, 2);
    // Unmapped schedule fields dropped
    assert.equal("etenr" in sched[0]!, false);
    assert.equal("slfdt" in sched[0]!, false);
  });
});

describe("transformResponse", () => {
  it("returns raw reference when friendly=false (zero overhead)", () => {
    const raw = { ebeln: "3010000608" };
    const result = transformResponse(raw, "/po/:ebeln", {
      friendly: false,
      includeSource: false,
    });
    assert.equal(result, raw);
  });

  it("wraps in envelope when friendly=true", () => {
    const raw = {
      ebeln: "3010000608",
      aedat: "20170306",
      lifnr: "0000500340",
      eindt: "20170630",
    };
    const result = transformResponse(raw, "/po/:ebeln", {
      friendly: true,
      includeSource: false,
    }) as Record<string, unknown>;

    const data = result.data as Record<string, unknown>;
    assert.equal(data.purchaseOrderNumber, "3010000608");
    assert.equal(data.createdAt, "2017-03-06");
    assert.equal(data.vendorNumber, "0000500340");
    assert.equal(data.deliveryDate, "2017-06-30");

    const links = result._links as Record<string, string>;
    assert.equal(links.self, "/po/3010000608");
    assert.equal(links.items, "/po/3010000608/items");

    assert.equal(result._source, undefined);
  });

  it("includes _source when requested", () => {
    const raw = {
      ebeln: "3010000608",
      aedat: "20170306",
      lifnr: "0000500340",
      eindt: "20170630",
    };
    const result = transformResponse(raw, "/po/:ebeln", {
      friendly: true,
      includeSource: true,
    }) as Record<string, unknown>;

    const source = result._source as Record<string, unknown>;
    assert.equal(source.ebeln, "3010000608");
    assert.equal(source.aedat, "20170306");
  });

  it("passes through unmapped routes (ping, healthz)", () => {
    const raw = { ok: true, sap_time: "20260422163000" };
    const result = transformResponse(raw, "/ping", {
      friendly: true,
      includeSource: false,
    });
    assert.equal(result, raw);
  });

  it("resolves material → stock link", () => {
    const raw = { matnr: "10000001", mtart: "Z010", maktx: "Test" };
    const result = transformResponse(raw, "/material/:matnr", {
      friendly: true,
      includeSource: false,
    }) as Record<string, unknown>;
    const links = result._links as Record<string, string>;
    assert.equal(links.self, "/material/10000001");
    assert.equal(links.stock, "/stock/10000001");
  });

  it("resolves stock → material link with werks", () => {
    const raw = { matnr: "10000001", werks: "1000" };
    const result = transformResponse(raw, "/stock/:matnr", {
      friendly: true,
      includeSource: false,
    }) as Record<string, unknown>;
    const links = result._links as Record<string, string>;
    assert.equal(links.self, "/stock/10000001");
    assert.equal(links.material, "/material/10000001");
  });
});

describe("parseTransformOpts", () => {
  it("defaults to friendly=true when no format param", () => {
    const opts = parseTransformOpts(() => undefined);
    assert.equal(opts.friendly, true);
    assert.equal(opts.includeSource, false);
  });

  it("sets friendly=false when format=raw", () => {
    const opts = parseTransformOpts((name) =>
      name === "format" ? "raw" : undefined,
    );
    assert.equal(opts.friendly, false);
  });

  it("sets includeSource=true when include=_source", () => {
    const opts = parseTransformOpts((name) =>
      name === "include" ? "_source" : undefined,
    );
    assert.equal(opts.includeSource, true);
  });

  it("handles comma-separated include values", () => {
    const opts = parseTransformOpts((name) =>
      name === "include" ? "_source,_links" : undefined,
    );
    assert.equal(opts.includeSource, true);
  });
});
