import { useEffect } from "react";
import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolStatus } from "./ToolStatus";
import { useChatStore } from "../../stores/chatStore";
import { useConductorStore } from "../../stores/conductorStore";

export function ChatView() {
  const initChatListener = useChatStore((s) => s.initListener);
  const destroyChatListener = useChatStore((s) => s.destroyListener);
  const initConductorListener = useConductorStore((s) => s.initListener);
  const destroyConductorListener = useConductorStore((s) => s.destroyListener);
  const error = useChatStore((s) => s.error);

  useEffect(() => {
    initChatListener().catch(console.error);
    initConductorListener().catch(console.error);
    return () => {
      destroyChatListener();
      destroyConductorListener();
    };
  }, [initChatListener, destroyChatListener, initConductorListener, destroyConductorListener]);

  return (
    <div className="chat-view">
      <MessageList />

      <div className="chat-bottom">
        {error && (
          <div className="chat-error">{error}</div>
        )}
        <ThinkingIndicator />
        <InputBar />
        <ToolStatus />
      </div>
    </div>
  );
}
