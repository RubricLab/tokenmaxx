import { Composition } from "remotion";
import { SwitchRotation } from "./SwitchRotation";
import { UsageTimelapse } from "./UsageTimelapse";

// Both comps take a themeName prop so dark + light render from one definition
// (see render.ts, which passes --props).
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="UsageTimelapse"
      component={UsageTimelapse}
      durationInFrames={175}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{ themeName: "dark" as const }}
    />
    <Composition
      id="SwitchRotation"
      component={SwitchRotation}
      durationInFrames={180}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{ themeName: "dark" as const }}
    />
  </>
);
