/**
 * Global `JSX` namespace for third-party type declarations written against React 18 typings
 * (TASK-143).
 *
 * React 19 types expose JSX only as `React.JSX`. `@dnd-kit/core` and `@dnd-kit/sortable` still
 * reference the global `JSX.Element` in their `.d.ts` files, and this project type-checks library
 * declarations (`skipLibCheck: false`). This file aliases the global names to React's own, so
 * those declarations resolve without weakening any check. Application code keeps using React's
 * JSX through the automatic runtime.
 */
import type { JSX as ReactJSX } from "react";

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}
