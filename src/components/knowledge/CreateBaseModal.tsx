import { memo, useCallback, useState } from "react";
import { Modal } from "../Modal";
import { useKnowledgeStore } from "../../stores/knowledgeStore";

interface CreateBaseModalProps {
  open: boolean;
  onClose: () => void;
}

export const CreateBaseModal = memo(function CreateBaseModal({ open, onClose }: CreateBaseModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createBase = useKnowledgeStore((s) => s.createBase);

  const resetForm = useCallback(() => {
    setName("");
    setDescription("");
  }, []);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    await createBase(name.trim(), description.trim());
    resetForm();
    onClose();
  }, [name, description, createBase, resetForm, onClose]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const actions = [
    { label: "Cancel", onClick: handleClose },
    { label: "Create", variant: "accent" as const, onClick: handleCreate, disabled: !name.trim() },
  ];

  return (
    <Modal open={open} title="Create Knowledge Base" onClose={handleClose} actions={actions}>
      <div className="kb-form">
        <label className="kb-form__label">
          Name
          <input
            className="kb-form__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My knowledge base"
            autoFocus
          />
        </label>
        <label className="kb-form__label">
          Description
          <textarea
            className="kb-form__textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this knowledge base contains..."
            rows={3}
          />
        </label>
      </div>
    </Modal>
  );
});
