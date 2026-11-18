import React from "react";
import "./boba-support.css";

// Official Boba destination and embed artwork supplied by the owner.
export const BOBA_SUPPORT_URL = "https://bitingbox.bobaboba.me";

export function BobaSupport() {
  let url: URL;
  try {
    url = new URL(BOBA_SUPPORT_URL);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch {
    return null;
  }
  return (
    <a
      className="bobaSupport"
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <img src="brand/boba-embed-icon.png" width="24" height="28" alt="" />
      <span>Give me a Boba!</span>
    </a>
  );
}
