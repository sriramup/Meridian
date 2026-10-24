/** Class strings shared by DropdownMenu, ContextMenu and Select so all lists feel identical. */
export const menuContent =
  "kit-surface kit-pop z-50 min-w-[10rem] overflow-x-hidden p-1 text-ink max-h-[var(--radix-dropdown-menu-content-available-height,var(--radix-context-menu-content-available-height,70vh))] overflow-y-auto";

export const menuItem =
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[12.5px] leading-none text-ink outline-none data-[highlighted]:bg-paper-3 data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-ink-3";

export const menuItemDanger = "text-bad data-[highlighted]:bg-bad-2 data-[highlighted]:text-bad [&_svg:not([class*='text-'])]:text-bad";

export const menuLabel = "px-2 pt-1.5 pb-1 font-legend text-[12px] leading-none text-ink-3";

export const menuSeparator = "-mx-1 my-1 h-px bg-line";

export const menuShortcut = "ml-auto pl-4 font-mono text-[10.5px] tracking-wide text-ink-4";

export const menuIndicator = "absolute left-2 flex size-3.5 items-center justify-center";
