import { describe, expect, it } from "vitest";
import { looseJsonBody } from "@/server/article";

function parse<T = Record<string, unknown>>(raw: string): T {
  return JSON.parse(looseJsonBody(raw)) as T;
}

describe("looseJsonBody 缺逗号修复", () => {
  it("sections 数组结束后直接跟 mindMap（线上 426e03a6 同型）", () => {
    const out = parse<{
      title: string;
      sections: Array<{ id: string }>;
      mindMap: Array<{ t: string }>;
    }>('{"title":"T","sections":[{"id":"s1","title":"A","summary":"x"}]\n    "mindMap":[{"t":"m"}]}');
    expect(out.title).toBe("T");
    expect(out.sections).toHaveLength(1);
    expect(out.mindMap).toEqual([{ t: "m" }]);
  });

  it("对象属性之间漏逗号（此前会被引号修复二次焊死）", () => {
    const out = parse<{ sections: Array<{ id: string; title: string; summary: string }> }>(
      '{"title":"T","sections":[{"id":"s1","title":"A"\n        "summary":"第一章的内容"}]}',
    );
    expect(out.sections[0].title).toBe("A");
    expect(out.sections[0].summary).toBe("第一章的内容");
  });

  it("数值/布尔值之后漏逗号", () => {
    expect(parse('{"a": 12\n"b": "c"}')).toEqual({ a: 12, b: "c" });
    expect(parse('{"a": true\n"b": 1}')).toEqual({ a: true, b: 1 });
  });

  it("合法 JSON 原样通过，不插入多余逗号", () => {
    const src = '{"a":"x","b":{"c":1},"d":[2,3],"e":true}';
    expect(parse(src)).toEqual(JSON.parse(src));
  });

  it("冒号后的引号是值不是 key，不插逗号", () => {
    expect(parse('{"a": "x"}')).toEqual({ a: "x" });
    expect(parse('{"a" : "x"}')).toEqual({ a: "x" });
  });

  it("字符串内部形如缺逗号的内容不受影响", () => {
    const out = parse<{ a: string; b: number }>('{"a":"he said ] \\"mid\\" then","b":1}');
    expect(out.a).toBe('he said ] "mid" then');
    expect(out.b).toBe(1);
  });

  it("key 内含未转义引号时不插逗号（只靠引号修复收口，不改坏字段名）", () => {
    // 审查确认缺陷：{"x":0,"a"b"c":1} 曾被插成 {"x":0,"a"b,"c":1}，字段名被静默篡改
    const out = parse<{ x: number }>('{ "x":0,"a"b"c":1 }');
    expect(out.x).toBe(0);
    expect(Object.keys(out)).toContain('a"b"c');
  });

  it("true/false/null 之后漏逗号仍正常补", () => {
    expect(parse('{"a": null\n"b": 2}')).toEqual({ a: null, b: 2 });
    expect(parse('{"a": false\n"b": 2}')).toEqual({ a: false, b: 2 });
  });

  it("端到端：围栏 + 前后杂文 + 缺逗号", () => {
    const raw = [
      "好的，以下是提纲：",
      "```json",
      '{"title":"视频拆解","sections":[{"id":"s1","title":"开篇"}]\n"mindMap":[]}',
      "```",
      "如有问题请告知。",
    ].join("\n");
    const out = parse<{ title: string; mindMap: unknown[] }>(raw);
    expect(out.title).toBe("视频拆解");
    expect(out.mindMap).toEqual([]);
  });

  it("blocks 数组对象之间漏逗号（线上 position 1411/1414 同型）", () => {
    const out = parse<{
      blocks: Array<{ type: string; text?: string; frameId?: string }>;
    }>(
      '{"blocks":[{"type":"paragraph","text":"甲"}{"type":"figure","frameId":"f01"}{"type":"paragraph","text":"乙"}]}',
    );
    expect(out.blocks).toEqual([
      { type: "paragraph", text: "甲" },
      { type: "figure", frameId: "f01" },
      { type: "paragraph", text: "乙" },
    ]);
  });

  it("跨行与嵌套数组只在数组元素之间补逗号", () => {
    const out = parse<{ tags: string[][]; blocks: Array<{ id: number }> }>(
      '{"tags":[["a","b"]\n["c"]],"blocks":[{"id":1}\n{"id":2}]}',
    );
    expect(out.tags).toEqual([["a", "b"], ["c"]]);
    expect(out.blocks).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("对象属性漏逗号仍由原逻辑修复，不被数组规则误伤", () => {
    expect(parse('{"a":{"x":1"y":2}}')).toEqual({ a: { x: 1, y: 2 } });
  });

  it("字符串内容里的 }{ 不被改坏", () => {
    expect(parse('{"a":"示例}{文本","b":1}')).toEqual({ a: "示例}{文本", b: 1 });
  });

  it("合法的相邻对象数组原样通过，不插入多余逗号", () => {
    const src = '{"blocks":[{"type":"paragraph","text":"甲"},{"type":"figure","frameId":"f01"}]}';
    expect(parse(src)).toEqual(JSON.parse(src));
  });

  it("未转义引号不把逗号插进数组字符串正文（审查缺陷）", () => {
    expect(parse('{"t":["x"y1{z}"w"]}')).toEqual({ t: ['x"y1{z}"w'] });
  });

  it("数组元素缺逗号修复覆盖字符串、容器与原始值（审查缺陷）", () => {
    expect(parse('{"t":["甲" "乙"]}')).toEqual({ t: ["甲", "乙"] });
    expect(parse('{"t":[{"a":1} "x"]}')).toEqual({ t: [{ a: 1 }, "x"] });
    expect(parse('{"t":[1 2]}')).toEqual({ t: [1, 2] });
  });

  it("合法数字与字符串数组不被误拆", () => {
    expect(parse('{"t":[12]}')).toEqual({ t: [12] });
    expect(parse('{"t":[1e3]}')).toEqual({ t: [1000] });
    expect(parse('{"t":["甲","乙"]}')).toEqual({ t: ["甲", "乙"] });
  });

  it("正文以引号结尾的字符串不被误拆成两个元素", () => {
    expect(parse('{"tags":["关键词"AI""]}')).toEqual({ tags: ['关键词"AI"'] });
    expect(parse('{"tags":["a"b"c"]}')).toEqual({ tags: ['a"b"c'] });
  });

  it("字符串元素后接容器或原始值也能补上逗号", () => {
    expect(parse('{"t":["甲" {"a":1}]}')).toEqual({ t: ["甲", { a: 1 }] });
    expect(parse('{"t":["甲" 1]}')).toEqual({ t: ["甲", 1] });
  });

  it("正文引号紧贴数字或括号不被误判为字符串收尾", () => {
    expect(parse('{"tags":["引用"2024"年的数据"]}')).toEqual({ tags: ['引用"2024"年的数据'] });
    expect(parse('{"tags":["花括号"{"的例子"]}')).toEqual({ tags: ['花括号"{"的例子'] });
    expect(parse('{"tags":["x"-1"y"]}')).toEqual({ tags: ['x"-1"y'] });
    expect(parse('{"tags":["a"1"b"]}')).toEqual({ tags: ['a"1"b'] });
  });

  it("开头为分隔符的字符串不打断括号栈（审查缺陷）", () => {
    expect(parse('{"a":[1,{}],"b":[" 1{"]}')).toEqual({ a: [1, {}], b: [" 1{"] });
  });

  it("正文仅末尾一个引号不被误拆（审查缺陷）", () => {
    expect(parse('{"tags":["他说""]}')).toEqual({ tags: ['他说"'] });
  });
});
