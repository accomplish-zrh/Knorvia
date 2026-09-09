"use client";

import { useState } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import type { Item } from "@/lib/native-workbench-state";
import { errorText, useWorkbench } from "./NativeWorkbenchProvider";

type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] };
export function UserInputCard({ item }: { item: Item }) {
  const { t, request, readThread, setError } = useWorkbench();
  const questions = ((item.payload.request as { questions?: Question[] } | undefined)?.questions ?? []);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const secret = questions.some(question => question.isSecret);
  return <form className="nw-approval nw-question-card" onSubmit={async event => {
    event.preventDefault(); if (pending || secret || !questions.length) return;
    setPending(true);
    try {
      await request("userInput/respond", { id: item.id, answers: Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id]?.trim() ?? ""] }])) });
      await readThread(item.threadId);
    } catch (error) { setError(errorText(error)); } finally { setPending(false); }
  }}><div className="nw-approval-title"><MessageCircleQuestion size={17} /><strong>{t("需要你补充一点信息", "A little input from you")}</strong></div>
    {secret ? <p>{t("此问题涉及私密凭据。请在安全的连接配置中设置凭据，再继续任务。", "This question involves private credentials. Configure them through a secure connection before continuing.")}</p> : questions.map(question => <fieldset key={question.id}><legend>{question.question}</legend>{question.options && <div className="nw-question-options">{question.options.map(option => <label key={option.label}><input type="radio" name={question.id} checked={answers[question.id] === option.label} onChange={() => setAnswers(current => ({ ...current, [question.id]: option.label }))} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div>}{(!question.options?.length || question.isOther) && <input className="nw-question-text" aria-label={question.question} placeholder={t("输入你的回答", "Your answer")} value={answers[question.id] ?? ""} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />}</fieldset>)}
    {!secret && <div className="nw-approval-actions"><button className="nw-button nw-button-primary" disabled={pending || !questions.length || questions.some(question => !answers[question.id]?.trim())}><Send size={13} />{t("提交回答", "Submit answer")}</button></div>}
  </form>;
}
