import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMAGE_BYTES, MAX_LINE_IMAGES } from "../src/domain/images.js";
import { boot, call, loginActors } from "./helpers.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

test("走查页没有币种选择，创建请购与事前都固定提交 CNY，贴图区可粘贴", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    const html = page.body;
    assert.equal(html.includes('name="currency"'), false);
    assert.equal(html.includes('form.get("currency")'), false);
    assert.equal(html.includes("<option value=\"HKD\">"), false);
    assert.equal((html.match(/currency:\s*"CNY"/g) ?? []).length, 2);
    assert.match(html, /id="pr-images"/);
    assert.match(html, /贴图/);
    assert.match(html, /addEventListener\("paste", onImagePaste\)/);
    assert.match(html, /addEventListener\("drop"/);
    assert.match(html, /img\.src = PREFIX \+ "\/api\/attachments\/" \+ encodeURIComponent\(image\.id\)/);
    assert.equal(/innerHTML[^;\n]*attachments/.test(html), false);
    assert.equal(/innerHTML[^;\n]*dataUrl/.test(html), false);
    const forms = html.match(/<form id="(?:pr|pre)-form">[\s\S]*?<\/form>/g) ?? [];
    assert.equal(forms.length, 2);
    for (const form of forms) {
      assert.match(form, /币种固定为 CNY/);
      assert.equal(form.includes("<select name=\"currency\""), false);
    }
  } finally {
    await app.close();
  }
});

test("创建请购可附贴图，单据只存元数据，缩略图走附件字节", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pngUrl = dataUrl("image/png", PNG_1X1);
    const created = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "带贴图的显示器",
      lines: [{
        itemName: "显示器",
        spec: "27 寸",
        qty: 1,
        estUnitPrice: "100.00",
        category: "consumable",
        images: [{ name: "<script>alert(1)</script>.png", dataUrl: pngUrl }],
      }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.currency, "CNY");
    assert.equal(created.body.companyCode, "SZ");
    const image = created.body.lines[0].images[0];
    assert.equal(image.mime, "image/png");
    assert.equal(image.byteLength, PNG_1X1.length);
    assert.match(image.id, /^IMG-\d+$/);
    assert.equal(image.name.includes("<"), false);
    assert.equal(image.name.includes(">"), false);
    assert.equal(JSON.stringify(created.body).includes("data:image"), false);
    assert.equal(JSON.stringify(created.body).includes(pngUrl.slice(40)), false);

    const fetched = await call(app, people.applicant, "GET", `/api/pr/${created.body.id}`);
    assert.equal(fetched.body.lines[0].images[0].id, image.id);

    const workspace = await call(app, people.applicant, "GET", "/api/workspace");
    const listed = workspace.body.prs.find((row: { id: string }) => row.id === created.body.id);
    assert.equal(listed.lines[0].images[0].id, image.id);
    assert.equal(JSON.stringify(listed).includes("base64"), false);

    const bytes = await app.inject({
      method: "GET",
      url: `/api/attachments/${image.id}`,
      headers: { cookie: people.applicant.cookie },
    });
    assert.equal(bytes.statusCode, 200);
    assert.equal(String(bytes.headers["content-type"]).startsWith("image/png"), true);
    assert.equal(bytes.headers["x-content-type-options"], "nosniff");
    assert.equal(bytes.rawPayload.equals(PNG_1X1), true);
    assert.equal(String(bytes.headers["content-disposition"]).includes(image.id), true);
    assert.equal(handle.store.images.get(image.id)?.bytes.equals(PNG_1X1), true);

    const anon = await app.inject({ method: "GET", url: `/api/attachments/${image.id}` });
    assert.equal(anon.statusCode, 401);

    const missing = await app.inject({
      method: "GET",
      url: "/api/attachments/IMG-9999",
      headers: { cookie: people.applicant.cookie },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("贴图拒绝非图片、类型不符、超张数和超大小，省略时为空数组", async () => {
  const { app, handle } = await boot();
  try {
    const people = await loginActors(app);
    const pngUrl = dataUrl("image/png", PNG_1X1);
    const line = {
      itemName: "纸",
      qty: 1,
      estUnitPrice: "1.00",
      category: "consumable",
    };

    const svg = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "svg",
      lines: [{ ...line, images: [{ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }] }],
    });
    assert.equal(svg.status, 400);
    assert.equal(svg.body.error, "INVALID_INPUT");

    const html = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "html",
      lines: [{
        ...line,
        images: [{ dataUrl: "data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" }],
      }],
    });
    assert.equal(html.status, 400);
    assert.equal(html.body.error, "INVALID_INPUT");

    const mismatch = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "mismatch",
      lines: [{
        ...line,
        images: [{ dataUrl: dataUrl("image/png", Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44])) }],
      }],
    });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.message, /类型不符/);

    const tooMany = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "too many",
      lines: [{
        ...line,
        images: Array.from({ length: MAX_LINE_IMAGES + 1 }, () => ({ dataUrl: pngUrl })),
      }],
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.message, /4 张/);

    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    PNG_1X1.copy(big);
    const tooBig = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "too big",
      lines: [{ ...line, images: [{ dataUrl: dataUrl("image/png", big) }] }],
    });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.message, /2MB/);
    assert.equal(handle.store.images.size, 0);

    const four = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "four",
      lines: [{
        ...line,
        images: Array.from({ length: MAX_LINE_IMAGES }, () => ({ dataUrl: pngUrl })),
      }],
    });
    assert.equal(four.status, 200, JSON.stringify(four.body));
    assert.equal(four.body.lines[0].images.length, MAX_LINE_IMAGES);

    const omitted = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "CNY",
      deptId: "D-ADMIN",
      purpose: "no images",
      lines: [line],
    });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
    assert.deepEqual(omitted.body.lines[0].images, []);

    const hkd = await call(app, people.applicant, "POST", "/api/pr", {
      currency: "HKD",
      deptId: "D-HK",
      purpose: "接口仍接受港币",
      lines: [line],
    });
    assert.equal(hkd.status, 200, JSON.stringify(hkd.body));
    assert.equal(hkd.body.currency, "HKD");
    assert.equal(hkd.body.companyCode, "HK");
  } finally {
    await app.close();
  }
});
