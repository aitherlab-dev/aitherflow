import { memo, useState, useCallback } from "react";
import { Check, X, HelpCircle, FileCheck } from "lucide-react";
import type {
  ToolActivity,
  AskUserQuestionInput,
  AskQuestion,
  ExitPlanModeInput,
} from "../../types/chat";
import { respondToCard } from "../../stores/chatService";

function asAskInput(input: Record<string, unknown>): AskUserQuestionInput | null {
  if (input && Array.isArray(input.questions)) {
    return input as unknown as AskUserQuestionInput;
  }
  return null;
}

function asExitPlanInput(input: Record<string, unknown>): ExitPlanModeInput {
  if (input && Array.isArray(input.allowedPrompts)) {
    return input as unknown as ExitPlanModeInput;
  }
  return {};
}

interface InteractiveCardProps {
  tool: ToolActivity;
  agentId: string;
}

export const InteractiveCard = memo(function InteractiveCard({
  tool,
  agentId,
}: InteractiveCardProps) {
  if (tool.toolName === "AskUserQuestion") {
    return <AskUserQuestionCard tool={tool} agentId={agentId} />;
  }
  if (tool.toolName === "ExitPlanMode") {
    return <ExitPlanModeCard tool={tool} agentId={agentId} />;
  }
  return null;
});

// ── AskUserQuestion ──

function AskUserQuestionCard({ tool, agentId }: { tool: ToolActivity; agentId: string }) {
  const input = asAskInput(tool.toolInput);
  const questions = input?.questions;
  const answered = !!tool.userResponse;

  if (!questions || questions.length === 0) return null;

  return (
    <div className={`interactive-card ${answered ? "interactive-card--answered" : ""}`}>
      <div className="interactive-card-header">
        <HelpCircle size={16} className="interactive-card-icon" />
        <span>Question</span>
      </div>
      {questions.map((q, i) => (
        <QuestionBlock
          key={i}
          question={q}
          toolUseId={tool.toolUseId}
          agentId={agentId}
          answered={answered}
          userResponse={tool.userResponse}
        />
      ))}
    </div>
  );
}

function QuestionBlock({
  question,
  toolUseId,
  agentId,
  answered,
  userResponse,
}: {
  question: AskQuestion;
  toolUseId: string;
  agentId: string;
  answered: boolean;
  userResponse?: string;
}) {

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleClick = useCallback(
    (label: string) => {
      if (answered) return;
      if (question.multiSelect) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(label)) next.delete(label);
          else next.add(label);
          return next;
        });
      } else {
        respondToCard(agentId, toolUseId, label).catch(console.error);
      }
    },
    [answered, question.multiSelect, agentId, toolUseId],
  );

  const handleSubmitMulti = useCallback(() => {
    if (answered || selected.size === 0) return;
    const response = Array.from(selected).join(", ");
    respondToCard(agentId, toolUseId, response).catch(console.error);
  }, [answered, selected, agentId, toolUseId]);

  return (
    <div className="interactive-card-question">
      <p className="interactive-card-question-text">{question.question}</p>
      <div className="interactive-card-options">
        {question.options.map((opt) => {
          const isSelected = answered
            ? userResponse === opt.label || (userResponse?.includes(opt.label) ?? false)
            : selected.has(opt.label);
          return (
            <button
              key={opt.label}
              className={`interactive-card-option ${isSelected ? "interactive-card-option--selected" : ""}`}
              onClick={() => handleClick(opt.label)}
              disabled={answered}
            >
              <span className="interactive-card-option-label">{opt.label}</span>
              {opt.description && (
                <span className="interactive-card-option-desc">{opt.description}</span>
              )}
              {isSelected && answered && <Check size={14} className="interactive-card-option-check" />}
            </button>
          );
        })}
      </div>
      {question.multiSelect && !answered && selected.size > 0 && (
        <button
          className="interactive-card-submit"
          onClick={handleSubmitMulti}
        >
          Submit
        </button>
      )}
    </div>
  );
}

// ── ExitPlanMode ──

function ExitPlanModeCard({ tool, agentId }: { tool: ToolActivity; agentId: string }) {
  const input = asExitPlanInput(tool.toolInput);

  const answered = !!tool.userResponse;
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const handleApprove = useCallback(() => {
    if (answered) return;
    respondToCard(agentId, tool.toolUseId, "yes").catch(console.error);
  }, [answered, agentId, tool.toolUseId]);

  const handleReject = useCallback(() => {
    if (answered) return;
    if (!rejecting) {
      setRejecting(true);
      return;
    }
    const reason = rejectReason.trim() || "Rejected by user";
    respondToCard(agentId, tool.toolUseId, `__deny__${reason}`).catch(console.error);
  }, [answered, rejecting, rejectReason, agentId, tool.toolUseId]);

  const prompts = input?.allowedPrompts;

  return (
    <div className={`interactive-card ${answered ? "interactive-card--answered" : ""}`}>
      <div className="interactive-card-header">
        <FileCheck size={16} className="interactive-card-icon" />
        <span>Plan approval</span>
      </div>

      {prompts && prompts.length > 0 && (
        <div className="interactive-card-prompts">
          <p className="interactive-card-prompts-label">Requested permissions:</p>
          <ul className="interactive-card-prompts-list">
            {prompts.map((p, i) => (
              <li key={i}>
                <span className="interactive-card-prompt-tool">{p.tool}</span>
                <span className="interactive-card-prompt-text">{p.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answered ? (
        <div className="interactive-card-result">
          {tool.userResponse === "yes" || tool.userResponse === "Auto-approved" ? (
            <span className="interactive-card-result--approved">
              {tool.userResponse === "Auto-approved" ? "Auto-approved" : "Approved"}
            </span>
          ) : (
            <span className="interactive-card-result--rejected">
              Rejected: {tool.userResponse}
            </span>
          )}
        </div>
      ) : (
        <div className="interactive-card-actions">
          {rejecting && (
            <input
              type="text"
              className="interactive-card-reject-input"
              placeholder="Reason for rejection..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.code === "Enter") handleReject();
              }}
              autoFocus
            />
          )}
          <div className="interactive-card-buttons">
            <button
              className="interactive-card-approve"
              onClick={handleApprove}
            >
              <Check size={14} />
              Approve
            </button>
            <button
              className="interactive-card-reject"
              onClick={handleReject}
            >
              <X size={14} />
              {rejecting ? "Send rejection" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
