"use client";

/** One AI classroom: the action-timeline player. */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import ClassroomPlayer from "@/components/classroom/ClassroomPlayer";
import {
  getClassroom,
  type ClassroomDocument,
} from "@/lib/classroom-api";

export default function ClassroomDetailPage() {
  const params = useParams<{ classroomId: string }>();
  const classroomId = decodeURIComponent(String(params.classroomId || ""));
  const { t } = useTranslation();
  const [document, setDocument] = useState<ClassroomDocument | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!classroomId) return;
    void getClassroom(classroomId)
      .then(setDocument)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : t("Load failed")),
      );
  }, [classroomId, t]);

  if (error) {
    return (
      <div className="px-4 py-10 text-center text-[13px] text-[var(--muted-foreground)]">
        {error}
      </div>
    );
  }
  if (!document) {
    return (
      <div className="flex justify-center py-16">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--muted-foreground)] border-t-transparent" />
      </div>
    );
  }
  return (
    <div className="h-[calc(100dvh-2rem)] px-2 py-2">
      <ClassroomPlayer
        document={document}
        onBack={() => window.history.back()}
        onDocumentUpdated={setDocument}
      />
    </div>
  );
}
