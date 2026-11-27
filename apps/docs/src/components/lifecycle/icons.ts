// The Lucide icons of the dashboard that its excerpts on the landing page show. The names
// are those of lucide-react in the dashboard, in kebab-case.
import archive from "lucide-static/icons/archive.svg?raw";
import ban from "lucide-static/icons/ban.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import copy from "lucide-static/icons/copy.svg?raw";
import eyeOff from "lucide-static/icons/eye-off.svg?raw";
import flaskConical from "lucide-static/icons/flask-conical.svg?raw";
import gauge from "lucide-static/icons/gauge.svg?raw";
import globe from "lucide-static/icons/globe.svg?raw";
import loaderCircle from "lucide-static/icons/loader-circle.svg?raw";
import lock from "lucide-static/icons/lock.svg?raw";
import mailWarning from "lucide-static/icons/mail-warning.svg?raw";
import megaphone from "lucide-static/icons/megaphone.svg?raw";
import panelLeft from "lucide-static/icons/panel-left.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import repeat2 from "lucide-static/icons/repeat-2.svg?raw";
import scanText from "lucide-static/icons/scan-text.svg?raw";
import send from "lucide-static/icons/send.svg?raw";
import shield from "lucide-static/icons/shield.svg?raw";
import target from "lucide-static/icons/target.svg?raw";

export const icons = {
  archive,
  ban,
  check,
  copy,
  "eye-off": eyeOff,
  "flask-conical": flaskConical,
  gauge,
  globe,
  "loader-circle": loaderCircle,
  lock,
  "mail-warning": mailWarning,
  megaphone,
  "panel-left": panelLeft,
  plus,
  "repeat-2": repeat2,
  "scan-text": scanText,
  send,
  shield,
  target,
} as const;

export type IconName = keyof typeof icons;
