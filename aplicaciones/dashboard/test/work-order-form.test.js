const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseWorkOrderFormText,
  validateWorkOrderAgainstProject,
  suggestPublicationRoute,
} = require("../lib/work-order-form");

test("interpreta un formulario de Adición y propone la ruta formal", () => {
  const form = parseWorkOrderFormText({
    fileName: "FORMULARIO DE ADICIÓN_0001920-2026-DT-FA_INTRADEVCO_48 RADIOS.pdf",
    pages: [`FORMULARIO DE ADICIÓN
INTRADEVCO INDUSTRIAL S.A. \tTIPO DE CLIENTE: \tEMPRESA PRIVADA
CANTIDAD DE RADIOS:\n48 RADIOS (43 PORTATILES Y 5 ATEX)
RUC: \t20417378911
FECHA: \t22/09/2026
ALTA - ALQUILER + SERVICIO \tSUB TIPO:
Nº DEL CONTRATO: \t0157-2026-PR`],
  });
  assert.equal(form.formType, "ADICION");
  assert.equal(form.formNumber, "1920");
  assert.equal(form.ruc, "20417378911");
  assert.equal(form.declaredRadioCount, 48);
  assert.equal(form.requiresCpeProgramming, true);
  const route = suggestPublicationRoute({ responsible: "Leonardo Aldazabal", razonSocial: "INTRADEVCO", workOrder: form }, new Date("2026-10-02T12:00:00Z"));
  assert.deepEqual(route, {
    clientPath: "PRIVADAS\\INTRADEVCO\\ADICION",
    formNumber: "1920",
    programmingDate: "2026-10-02",
    programmerInitials: "LA",
  });
});

test("un Cambio solo de antenas no crea una programación CPE", () => {
  const form = parseWorkOrderFormText({
    fileName: "FORMULARIO DE CAMBIO_0000744_2026-DT-FC_TRAMARSA_18 ANTENAS.pdf",
    pages: [`FORMULARIO DE CAMBIO
CLIENTE: \tTRABAJOS MARITIMOS S.A. \tTIPO DE CLIENTE: \tEMPRESA PRIVADA
RUC: \t20101395031
CAMBIO DE ACCESORIOS \tMOTIVO: \tFALLA TECNICA
CANTIDAD DE ACCESORIOS:\n18 ANTENAS MTP3550`],
  });
  assert.equal(form.accessoryCount, 18);
  assert.equal(form.accessoryOnly, true);
  assert.equal(form.requiresCpeProgramming, false);
});

test("Programación acepta el total declarado o el lote actual", () => {
  const form = parseWorkOrderFormText({
    fileName: "FORMULARIO DE PROGRAMACIÓN_0000776-2026-DT-FPG_MLV.pdf",
    pages: [
      `FORMULARIO DE PROGRAMACIÓN
CLIENTE: \tMUNICIPALIDAD DE LA VICTORIA \tTIPO DE CLIENTE: \tENTIDAD DEL ESTADO
RUC: \t20131368071
CANTIDAD DE RADIOS: \t254 portátiles y 13 bases
TIPO DE REQUERIMIENTO: \tADICIÓN DE GRUPOS`,
      "POR EL MOMENTO SERAN LAS 200 YA QUE LAS 54 DESPUES SE ENTREGARAN AL CLIENTE",
    ],
  });
  assert.equal(form.declaredRadioCount, 267);
  assert.equal(form.currentBatchCount, 200);
  for (const radios of [200, 267]) {
    const result = validateWorkOrderAgainstProject(form, {
      summary: { ruc: form.ruc, razonSocial: "MUNICIPALIDAD LA VICTORIA", radios, contractRef: "" },
    });
    assert.equal(result.valid, true);
  }
});

test("bloquea diferencias administrativas entre PDF y Excel", () => {
  const form = parseWorkOrderFormText({
    fileName: "FORMULARIO DE ADICIÓN_0001920-2026-DT-FA_CLIENTE_48 RADIOS.pdf",
    pages: [`FORMULARIO DE ADICIÓN
CLIENTE OFICIAL S.A. \tTIPO DE CLIENTE: \tEMPRESA PRIVADA
RUC: \t20417378911
CANTIDAD DE RADIOS:\n48 RADIOS
ALTA \tSUB TIPO:`],
  });
  const result = validateWorkOrderAgainstProject(form, {
    summary: { ruc: "99999999999", razonSocial: "OTRO CLIENTE", radios: 47, contractRef: "" },
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
});
