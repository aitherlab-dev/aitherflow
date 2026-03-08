import { memo, useCallback, useEffect, useRef, useState } from "react";

export const InlineNameInput = memo(function InlineNameInput({
  placeholder,
  initialValue = "",
  selectStem = false,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initialValue?: string;
  selectStem?: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const submittedRef = useRef(false);

  useEffect(() => {
    // Delay focus to avoid race with menu closing
    const id = requestAnimationFrame(() => {
      const input = ref.current;
      if (!input) return;
      input.focus();
      if (selectStem && initialValue) {
        // Select just the name without extension (e.g. "file" in "file.txt")
        const dotIdx = initialValue.lastIndexOf(".");
        if (dotIdx > 0) {
          input.setSelectionRange(0, dotIdx);
        } else {
          input.select();
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter" && value.trim()) {
        submittedRef.current = true;
        onSubmit(value.trim());
      } else if (e.code === "Escape") {
        onCancel();
      }
    },
    [value, onSubmit, onCancel],
  );

  const handleBlur = useCallback(() => {
    // Small delay so Enter/click handlers fire before blur cancels
    setTimeout(() => {
      if (!submittedRef.current) onCancel();
    }, 100);
  }, [onCancel]);

  return (
    <div className="files-entry files-inline-input">
      <input
        ref={ref}
        className="files-inline-input__field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
});
