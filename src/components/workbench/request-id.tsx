/** 错误框里的请求编号：可选中复制，便于和服务端日志对照 */
export function RequestIdLine({ id }: { id: string | null }) {
  if (!id) return null;
  return (
    <span
      className="mt-1 block select-all font-mono text-[10px] leading-relaxed text-paper-faint"
      title="排查问题时请提供此编号"
    >
      请求 ID：{id}
    </span>
  );
}
