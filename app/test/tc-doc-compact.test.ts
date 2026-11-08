import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "./helpers.js";

interface El {
  tag: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  children: El[];
  append: (...nodes: El[]) => void;
}

function extractFn(html: string, name: string): string {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, name);
  const open = html.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, name);
  return html.slice(start, end + 1);
}

function loadFns(html: string) {
  const names = ["statusLabel", "prLineDetail", "docListedInTodos", "compactDocLine", "renderCompactDoc"];
  const source = names.map((name) => extractFn(html, name)).join("\n");
  return new Function(`${source}\nreturn { ${names.join(", ")} };`)() as {
    statusLabel: (code: string | null) => string;
    docListedInTodos: (rows: Array<{ id?: string } | null> | null, id: string) => boolean;
    compactDocLine: (kind: string, doc: Record<string, unknown> | null) => string;
    renderCompactDoc: (kind: string, doc: Record<string, unknown>) => El;
  };
}

function installDocument(): () => void {
  const previous = (globalThis as { document?: unknown }).document;
  function ElNode(this: El, tag: string) {
    this.tag = tag;
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.children = [];
  }
  ElNode.prototype.append = function append(this: El, ...nodes: El[]) {
    for (const node of nodes) {
      if (node) this.children.push(node);
    }
  };
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string) {
      return new (ElNode as unknown as new (tag: string) => El)(tag);
    },
  };
  return () => {
    (globalThis as { document?: unknown }).document = previous;
  };
}

function texts(node: El): string[] {
  const found: string[] = [];
  const visit = (el: El) => {
    if (el.textContent) found.push(el.textContent);
    for (const child of el.children) visit(child);
  };
  visit(node);
  return found;
}

function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.ok(from >= 0, start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(to > from, end);
  return html.slice(from, to);
}

function assertCompactFirst(loop: string, idExpr: string, kind: string) {
  const gate = loop.indexOf(`docListedInTodos(todos, ${idExpr})`);
  const compact = loop.indexOf(`renderCompactDoc("${kind}"`);
  const cont = loop.indexOf("continue;");
  const reject = loop.indexOf("appendRejectReason");
  const button = loop.indexOf("button(");
  assert.ok(gate >= 0, idExpr);
  assert.ok(compact > gate && cont > compact);
  assert.ok(reject > cont);
  assert.ok(button > cont);
  assert.equal(loop.includes("reject-reason"), false);
}

test("待办里已有的单据在单据区只留摘要，驳回条和按钮留在待办", async () => {
  const { app } = await boot();
  const restore = installDocument();
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    const html = page.body;

    const todoCard = html.match(/function renderTodoCard\(row\) \{[\s\S]*?\n    \}/);
    assert.ok(todoCard, "renderTodoCard missing");
    assert.match(todoCard[0], /appendRejectReason\(block, row\)/);
    assert.match(todoCard[0], /button\("编辑", "edit", row\.id, "ghost", row\.entity\)/);
    assert.match(todoCard[0], /重新提交/);
    assert.match(todoCard[0], /button\("取消请购", "pr-cancel", row\.id, "danger"\)/);
    assert.match(todoCard[0], /button\("通过", decision\[0\], row\.id\)/);
    assert.match(todoCard[0], /button\("驳回", decision\[1\], row\.id, "danger"\)/);
    assert.equal(todoCard[0].includes("renderCompactDoc"), false);

    const compactSrc = extractFn(html, "renderCompactDoc");
    assert.match(compactSrc, /处理请用上方待办/);
    assert.match(compactSrc, /statusLabel\(doc\.status\)/);
    assert.equal(compactSrc.includes("appendRejectReason"), false);
    assert.equal(compactSrc.includes("button("), false);
    assert.equal(compactSrc.includes("reject-reason"), false);
    assert.equal(compactSrc.includes("rejectReason"), false);

    assertCompactFirst(between(html, "for (const pr of", "for (const po of"), "pr.id", "PR");
    assertCompactFirst(between(html, "for (const prepay of", "for (const pay of"), "prepay.id", "PREPAY");
    assertCompactFirst(between(html, "for (const pre of", "for (const expense of"), "pre.id", "PRE");
    assertCompactFirst(between(html, "for (const expense of", "const endedCount"), "expense.id", "EXP");

    assert.match(html, /button\("编辑", "edit", pr\.id, "ghost", "PR"\)/);
    assert.match(html, /button\("编辑", "edit", prepay\.id, "ghost", "PREPAY"\)/);
    assert.match(html, /button\("编辑", "edit", pre\.id, "ghost", "PRE"\)/);
    assert.match(html, /button\("编辑", "edit", expense\.id, "ghost", "EXP"\)/);
    assert.match(html, /appendRejectReason\(block, pr\)/);
    assert.match(html, /appendRejectReason\(block, prepay\)/);
    assert.match(html, /appendRejectReason\(block, pre\)/);
    assert.match(html, /appendRejectReason\(block, expense\)/);

    const view = loadFns(html);
    const todos = [
      { id: "PR-0021" },
      { id: "PRE-8" },
      { id: "EXP-2" },
      { id: "PP-1" },
    ];
    assert.equal(view.docListedInTodos(todos, "PR-0021"), true);
    assert.equal(view.docListedInTodos(todos, "PR-0099"), false);
    assert.equal(view.docListedInTodos(null, "PR-0021"), false);
    assert.equal(view.docListedInTodos([{ id: "PR-0021" }, null], ""), false);
    assert.equal(view.docListedInTodos([{ id: "OTHER" }], "PR-0021"), false);

    const pr = view.renderCompactDoc("PR", {
      id: "PR-0021",
      docNo: "PR-0021",
      purpose: "会议室显示器",
      amount: "2000.00",
      currency: "CNY",
      status: "rejected",
      rejectReason: "确认价格",
      companyCode: "SZ",
      docType: "standard",
      lines: [{ itemName: "显示器", spec: "27 寸 IPS，壁挂支架", purchaseUrl: "https://example.com/monitor" }],
    });
    assert.equal(pr.dataset.compact, "todo");
    assert.equal(pr.dataset.id, "PR-0021");
    assert.deepEqual(texts(pr), [
      "PR-0021 · 会议室显示器 · 2000.00 CNY",
      "请购 · 已驳回",
      "显示器 · 规格 27 寸 IPS，壁挂支架 · https://example.com/monitor",
      "处理请用上方待办",
    ]);
    assert.equal(pr.children.some((child) => child.tag === "button" || child.className === "reject-reason" || child.className === "row"), false);
    assert.equal(texts(pr).some((line) => line.includes("确认价格") || line.includes("驳回理由")), false);
    assert.equal(texts(pr).some((line) => line.includes("SZ/CNY")), false);

    const pre = view.renderCompactDoc("PRE", {
      id: "PRE-8",
      docNo: "PRE-8",
      purpose: "出差",
      amount: "80.00",
      currency: "CNY",
      status: "draft",
      rejectReason: null,
    });
    assert.deepEqual(texts(pre), [
      "PRE-8 · 事前 80.00 CNY · 出差",
      "事前 · 草稿",
      "处理请用上方待办",
    ]);

    const expense = view.renderCompactDoc("EXP", {
      id: "EXP-2",
      docNo: "EXP-2",
      purpose: "出租车",
      amount: "90.00",
      currency: "CNY",
      status: "rejected",
      rejectReason: "票不对",
      invoiceNos: ["INV-1"],
    });
    assert.equal(view.compactDocLine("EXP", {
      purpose: "出租车",
      invoiceNos: ["INV-1"],
    }), "出租车 · 发票 INV-1");
    assert.deepEqual(texts(expense), [
      "EXP-2 · 报销 90.00 CNY",
      "报销 · 已驳回",
      "出租车 · 发票 INV-1",
      "处理请用上方待办",
    ]);
    assert.equal(texts(expense).some((line) => line.includes("票不对")), false);

    const prepay = view.renderCompactDoc("PREPAY", {
      id: "PP-1",
      docNo: "PP-1",
      amount: "40.00",
      currency: "HKD",
      status: "rejected",
      rejectReason: "比例不对",
      contractNo: "CT-9",
    });
    assert.equal(view.compactDocLine("PREPAY", { contractNo: "  " }), "");
    assert.equal(view.compactDocLine("PREPAY", { contractNo: "CT-9" }), "合同 CT-9");
    assert.deepEqual(texts(prepay), [
      "PP-1 · 预付 40.00 HKD",
      "预付 · 已驳回",
      "合同 CT-9",
      "处理请用上方待办",
    ]);
    assert.equal(view.statusLabel("submitted"), "待审批");
    assert.equal(texts(prepay).join("\n").includes("驳回理由"), false);
  } finally {
    restore();
    await app.close();
  }
});
