import "@fontsource-variable/nunito";
import { useEffect, useState } from "react";
import { Composition, continueRender, delayRender } from "remotion";
import {
  DURATION,
  FPS,
  HEIGHT,
  QueueExplainer,
  V_HEIGHT,
  V_WIDTH,
  WIDTH,
  type ExplainerProps,
} from "../src/explainer/QueueExplainer";

function WithFonts(props: ExplainerProps) {
  // Wait for the web fonts so no frame renders in a fallback face.
  const [handle] = useState(() => delayRender("Loading fonts"));
  useEffect(() => {
    void document.fonts.ready.then(() => continueRender(handle));
  }, [handle]);
  return <QueueExplainer {...props} />;
}

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="QueueExplainer"
        component={WithFonts}
        durationInFrames={DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ variant: "video" } satisfies ExplainerProps}
      />
      <Composition
        id="QueueExplainerVertical"
        component={WithFonts}
        durationInFrames={DURATION}
        fps={FPS}
        width={V_WIDTH}
        height={V_HEIGHT}
        defaultProps={{ variant: "video" } satisfies ExplainerProps}
      />
    </>
  );
}
