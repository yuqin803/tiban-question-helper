import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeEndpoint, permissionPattern, validateSettings, parseAnswer, safeError, requestAnswer } from "../extension/core.mjs";

const settings = { ...DEFAULT_SETTINGS, baseUrl: "https://api.example.test/v1", model: "example-model", apiKey: "secret-123456789" };
const answer = { answer: "B", explanation: "2 + 2 = 4。", uncertain: false, recognizedQuestion: "2 + 2 等于多少？" };
const apiResponse = (content = JSON.stringify(answer), extra = {}) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop", ...extra }] }), { status: 200, headers: { "Content-Type": "application/json" } });

test("public defaults cannot start a model request before configuration", async () => {
  let calls=0;
  await assert.rejects(requestAnswer({settings:DEFAULT_SETTINGS,question:'2 + 2 等于多少？',fetchImpl:async()=>{calls++;return apiResponse()}}));
  assert.equal(calls,0);
  assert.equal(DEFAULT_SETTINGS.apiKey,'');
});

test("endpoint normalization preserves provider path and avoids duplicate chat/completions", () => {
  assert.equal(normalizeEndpoint(" https://API.EXAMPLE.test/v1/ "), "https://api.example.test/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://api.example.test/v4/chat/completions/"), "https://api.example.test/v4/chat/completions");
  assert.equal(normalizeEndpoint("http://127.0.0.1:8765/v1"), "http://127.0.0.1:8765/v1/chat/completions");
  assert.equal(normalizeEndpoint("http://[::1]:8000"), "http://[::1]:8000/chat/completions");
  assert.equal(permissionPattern("http://localhost:8765/v1"), "http://localhost/*");
  assert.equal(permissionPattern("https://api.example.test:8443/path"), "https://api.example.test/*");
});

test("reject insecure remote hosts, credentials, query and invalid schemes", () => {
  for (const value of ["", "api.example.test", "http://example.test/v1", "http://localhost.evil.test", "http://192.168.1.1", "ftp://localhost/v1", "https://user:password@example.test/v1", "https://@example.test", "https://example.test/v1?key=secret", "https://example.test/v1?", "https://example.test/v1#fragment", "https://example.test\\evil"]) {
    assert.throws(() => normalizeEndpoint(value), Error, value);
  }
  assert.throws(() => normalizeEndpoint("https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"), /工作空间 ID/u);
  assert.throws(() => normalizeEndpoint("https://%7BWorkspaceId%7D.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"), /工作空间 ID/u);
});

test("settings validation whitelists fields and protects missing keys", () => {
  const normalized = validateSettings({ ...settings, autoAnswer: false, vision: true, unrelated: "private", apiKey: "  secret  " });
  assert.deepEqual(Object.keys(normalized), Object.keys(DEFAULT_SETTINGS));
  assert.equal(normalized.apiKey, "secret");
  assert.equal(normalized.autoAnswer, false);
  assert.equal(normalized.vision, true);
  assert.throws(() => validateSettings({ ...settings, apiKey: "" }), /API Key/u);
  assert.throws(() => validateSettings({ ...settings, model: " " }), /模型 ID/u);
  assert.throws(() => validateSettings({ ...settings, apiKey: "a\nb" }), /换行/u);
  assert.equal(validateSettings({ ...settings, baseUrl: "http://localhost:8765/v1", apiKey: "" }).apiKey, "");
});

test("parse JSON, fenced JSON, multimodal text and a plain text fallback", () => {
  assert.deepEqual(parseAnswer(JSON.stringify(answer)), answer);
  assert.deepEqual(parseAnswer(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``), answer);
  assert.deepEqual(parseAnswer(`参考结果：${JSON.stringify(answer)}`), answer);
  assert.deepEqual(parseAnswer([{ type: "text", text: JSON.stringify(answer) }]), answer);
  assert.equal(parseAnswer('{"answer":["A","C"],"uncertain":false}').answer, "A、C");
  assert.equal(parseAnswer('{"answer":42}').uncertain, true);
  assert.equal(parseAnswer("答案：B").uncertain, true);
  assert.equal(parseAnswer("<script>alert(1)</script>").answer, "<script>alert(1)</script>");
  assert.throws(() => parseAnswer(""), /没有返回答案/u);
});

test('blank answer parsing preserves blank order, zero and punctuation within each blank',()=>{
  const result=parseAnswer(JSON.stringify({blankAnswers:[' 1,2 ',0,'氢、氧'],uncertain:false,recognizedQuestion:'依次填空'}));
  assert.deepEqual(result.blankAnswers,['1,2','0','氢、氧']);
  assert.equal(result.answer,'1,2；0；氢、氧');assert.equal(result.uncertain,false);
});

test('malformed or empty blank entries make the model response uncertain instead of shifting answers',()=>{
  for(const blankAnswers of [['氢',''],['氢',null],{first:'氢'},[],Array(21).fill('氢')]) {
    const result=parseAnswer(JSON.stringify({answer:'氢、氧',blankAnswers,uncertain:false}));
    assert.equal(result.uncertain,true);assert.deepEqual(result.blankAnswers,[]);
  }
});

test("text request contains only selected question and required compatible fields", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await requestAnswer({
    settings: { ...settings, pageUrl: "https://private.school.test/token" },
    question: { text: "2 + 2 等于多少？\nA. 3\nB. 4", url: "https://private.school.test/token", title: "张同学个人主页" },
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.example.test/v1/chat/completions");
      assert.equal(options.headers.Authorization, `Bearer ${settings.apiKey}`);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      const payload = JSON.parse(options.body);
      assert.deepEqual(Object.keys(payload), ["model", "messages", "stream"]);
      assert.equal(payload.stream, false);
      assert.match(payload.messages[1].content, /2 \+ 2/u);
      assert.doesNotMatch(options.body, /private\.school|张同学|secret-123456789/u);
      return apiResponse();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, answer);
});

test("vision requires opt-in and supports image-only question", async () => {
  const image = "data:image/png;base64,YWJj";
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const content = JSON.parse(options.body).messages[1].content;
    assert.equal(content[1].image_url.url, image);
    return apiResponse();
  };
  await assert.rejects(requestAnswer({ settings: { ...settings, vision: false }, question: "图片题", image, fetchImpl }), /启用图片识别/u);
  assert.equal(calls, 0);
  await requestAnswer({ settings: { ...settings, vision: true }, question: "", image, fetchImpl });
  assert.equal(calls, 1);
  await assert.rejects(requestAnswer({ settings: { ...settings, vision: true }, question: "图片题", image: "https://tracking.example/pixel", fetchImpl }), /图片格式/u);
});

test("Alibaba DeepSeek v4 preserves the installed thinking mode without leaking provider flags to other APIs", async () => {
  for (const [baseUrl, model, expected] of [
    ["https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "deepseek-v4.1-flash", true],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "deepseek-v4.1-flash", true],
    ["https://api.example.test/v1", "deepseek-v4.1-flash", undefined],
    ["https://dashscope.aliyuncs.com.evil.test/v1", "deepseek-v4.1-flash", undefined],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "other-model", undefined],
  ]) {
    await requestAnswer({ settings: { ...settings, baseUrl, model }, question: "题目", fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).enable_thinking, expected);
      return apiResponse();
    } });
  }
});

test("empty and excessive questions are rejected before network access", async () => {
  const fetchImpl = () => { throw new Error("must not fetch"); };
  await assert.rejects(requestAnswer({ settings, question: " ", fetchImpl }), /还没有识别/u);
  await assert.rejects(requestAnswer({ settings, question: "题".repeat(12001), fetchImpl }), /12000/u);
});

test("HTTP errors are actionable, secrets redacted, no retry is performed", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    let calls = 0;
    await assert.rejects(requestAnswer({
      settings,
      question: "题目",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: `Rejected ${settings.apiKey} and Bearer other-secret` } }), { status });
      },
    }), (error) => {
      assert.match(error.message, new RegExp(String(status)));
      assert.doesNotMatch(error.message, /secret-123456789|other-secret/u);
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.doesNotMatch(safeError(new Error(`echo ${settings.apiKey}`), settings.apiKey), /secret-123456789/u);
});

test("malformed, empty, refused and truncated responses never masquerade as answers", async () => {
  const cases = [
    [new Response("not-json"), /有效 JSON/u],
    [new Response(JSON.stringify({ data: "unexpected" })), /choices/u],
    [apiResponse(""), /没有返回答案/u],
    [apiResponse("partial", { finish_reason: "length" }), /截断/u],
    [apiResponse("", { message: { refusal: "无法处理" } }), /未提供解答/u],
    [apiResponse("", { finish_reason: "tool_calls", message: { tool_calls: [{ id: "a" }] } }), /工具调用/u],
  ];
  for (const [response, expected] of cases) {
    await assert.rejects(requestAnswer({ settings, question: "题目", fetchImpl: async () => response }), expected);
  }
});

test("aborted requests are not started and in-flight AbortError is preserved", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(requestAnswer({ settings, question: "题目", signal: before.signal, fetchImpl: async () => { calls += 1; return apiResponse(); } }), { name: "AbortError" });
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(requestAnswer({
    settings,
    question: "题目",
    signal: during.signal,
    fetchImpl: async () => {
      during.abort();
      throw new DOMException("aborted", "AbortError");
    },
  }), { name: "AbortError" });
});
