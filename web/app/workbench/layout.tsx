import { NativeWorkbenchProvider } from "@/components/native/NativeWorkbenchProvider";
import { WorkbenchShell } from "@/components/native/WorkbenchShell";
import { WorkbenchStyleSync } from "@/components/native/WorkbenchStyle";
import "@/components/native/workbench.css";
import "@/components/native/workspace-tools.css";
import "@/components/native/brand-theme.css";
import "@/components/native/workbench-polish.css";
import "@/components/native/settings-sidebar.css";
import "@/components/native/task-panel.css";
import "@/components/native/appearance.css";
import "@/components/native/conversation-navigation.css";
import "@/components/native/library.css";
import "@/components/native/studio.css";
import "@/components/native/select-controls.css";
import "@/components/native/component-finish.css";
import "@/components/native/motion.css";
import "@/components/native/background.css";
import "@/components/native/workbench-style-choice.css";
import "@/components/native/luminous.css";

export default function WorkbenchLayout({ children }: { children: React.ReactNode }) {
  return <NativeWorkbenchProvider><WorkbenchStyleSync /><WorkbenchShell>{children}</WorkbenchShell></NativeWorkbenchProvider>;
}
