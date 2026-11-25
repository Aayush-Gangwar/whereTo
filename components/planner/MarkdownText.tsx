"use client";
import { memo } from "react";
import remarkGfm from "remark-gfm";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

const components = {
  h1: (p: any) => <h1 className="mb-2 mt-4 text-lg font-semibold tracking-tight text-slate-900 first:mt-0" {...p} />,
  h2: (p: any) => <h2 className="mb-2 mt-4 text-base font-semibold tracking-tight text-slate-900 first:mt-0" {...p} />,
  h3: (p: any) => <h3 className="mb-1.5 mt-3 text-[15px] font-semibold text-slate-900 first:mt-0" {...p} />,
  p: (p: any) => <p className="my-2 leading-7 first:mt-0 last:mb-0" {...p} />,
  ul: (p: any) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-slate-400" {...p} />,
  ol: (p: any) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-slate-400" {...p} />,
  li: (p: any) => <li className="pl-0.5 leading-7" {...p} />,
  strong: (p: any) => <strong className="font-semibold text-slate-900" {...p} />,
  em: (p: any) => <em className="italic" {...p} />,
  a: (p: any) => <a className="font-medium text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-600" target="_blank" rel="noreferrer" {...p} />,
  blockquote: (p: any) => <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600" {...p} />,
  hr: () => <hr className="my-3 border-slate-200" />,
  code: (p: any) => <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[13px] text-slate-800" {...p} />,
  pre: (p: any) => <pre className="my-2 overflow-x-auto rounded-lg bg-[#0f172a] p-3 font-mono text-[13px] text-[#e2e8f0]" {...p} />,
  table: (p: any) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-left text-[13px]" {...p} /></div>,
  th: (p: any) => <th className="border-b border-slate-300 px-2 py-1 font-semibold" {...p} />,
  td: (p: any) => <td className="border-b border-slate-100 px-2 py-1" {...p} />,
};

export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={components} className="text-[15px] text-slate-700" />;
});
