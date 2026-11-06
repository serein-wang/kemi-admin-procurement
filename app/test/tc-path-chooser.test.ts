import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "./helpers.js";

test("走查第一步先选路径，公司采购只出请购表单，员工垫付只出事前表单", async () => {
  const { app } = await boot();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    const html = page.body;
    assert.match(html, /id="path-chooser"/);
    assert.match(html, /id="choose-company"/);
    assert.match(html, /公司采购/);
    assert.match(html, /id="choose-reimburse"/);
    assert.match(html, /员工垫付报销/);
    assert.match(html, /id="change-path"/);
    assert.match(html, /返回重选路径/);
    assert.match(html, /id="path-chooser"[^>]*hidden/);
    assert.match(html, /id="path-workspace"[^>]*hidden/);
    assert.match(html, /id="pr-card"[^>]*hidden/);
    assert.match(html, /id="pre-card"[^>]*hidden/);
    assert.match(html, /chooser\.hidden = !loggedIn \|\| Boolean\(selectedPath\)/);
    assert.match(html, /prCard\.hidden = selectedPath !== "company"/);
    assert.match(html, /preCard\.hidden = selectedPath !== "reimburse"/);
    assert.match(html, /selectedPath === "company" \? workspace\.prs : \[\]/);
    assert.match(html, /selectedPath === "reimburse" \? \(workspace\.pres \|\| \[\]\) : \[\]/);
    assert.match(html, /selectedPath === "reimburse" \? \(workspace\.expenses \|\| \[\]\) : \[\]/);
    assert.match(html, /\/auth\/dev-login/);

    const forms = html.match(/<form id="(?:pr|pre)-form">[\s\S]*?<\/form>/g) ?? [];
    assert.equal(forms.length, 2);
    const [prForm, preForm] = forms;
    assert.match(prForm ?? "", /id="pr-form"/);
    assert.match(preForm ?? "", /id="pre-form"/);
    const itemAt = (prForm ?? "").indexOf('name="itemName"');
    const categoryAt = (prForm ?? "").indexOf('name="category"');
    assert.ok(itemAt >= 0 && categoryAt > itemAt);
    assert.match(prForm ?? "", /贴图/);
    assert.match(prForm ?? "", /name="purchaseUrl"/);
    assert.match(prForm ?? "", /币种固定为 CNY/);
    assert.match(preForm ?? "", /币种固定为 CNY/);
    assert.equal((prForm ?? "").includes("公司"), false);
    assert.equal((preForm ?? "").includes("公司"), false);
    assert.equal(html.includes('name="companyCode"'), false);
    assert.equal((html.match(/currency:\s*"CNY"/g) ?? []).length, 2);
  } finally {
    await app.close();
  }
});
