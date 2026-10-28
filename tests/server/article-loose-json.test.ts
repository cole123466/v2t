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
});
