"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

// Textarea is uncontrolled; after a server action commits, React keeps the
// DOM node's typed value. Reset the form once the button's pending state
// (the send loader) flips back to false.
export function ChatComposerReset() {
  const { pending } = useFormStatus();
  const markerRef = useRef<HTMLSpanElement>(null);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending) {
      markerRef.current?.closest("form")?.reset();
    }
    wasPending.current = pending;
  }, [pending]);

  return <span ref={markerRef} hidden />;
}
