"use client";

import { useTranslation } from "react-i18next";

import { ServiceConfigEditor } from "@/components/settings/ServiceConfigEditor";
import { SettingsPageHeader } from "@/components/settings/shared";

export default function VideoGenSettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <SettingsPageHeader
        title={t("Video Generation")}
        description={t(
          "Video models shared by Video Studio and the chat agent. Configure each model's supported operations and output controls here; every job is authorized and archived in the workbench.",
        )}
      />
      <ServiceConfigEditor service="videogen" />
    </div>
  );
}
