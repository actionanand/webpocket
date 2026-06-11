const fileInputs = document.querySelectorAll("input[type='file']");
const processingOverlay = document.querySelector("[data-processing-overlay]");
const processingTitle = document.querySelector("[data-processing-title]");
const processingMessage = document.querySelector("[data-processing-message]");
const confirmOverlay = document.querySelector("[data-confirm-overlay]");
const confirmMessage = document.querySelector("[data-confirm-message]");
const confirmCancel = document.querySelector("[data-confirm-cancel]");
const confirmRemove = document.querySelector("[data-confirm-remove]");
const pageControls = document.querySelectorAll("button, input, select, textarea");

const processingCopy = {
  "save-single": {
    title: "Saving single page",
    message: "Fetching the web page now. Please keep this tab open while webpocket embeds the page for offline reading."
  },
  "download-html": {
    title: "Preparing single HTML",
    message: "Fetching the web page now. Your standalone HTML download will start as soon as it is ready.",
    download: true
  },
  "download-zip": {
    title: "Preparing ZIP package",
    message: "Fetching the web page assets now. Large pages may take a minute before the ZIP download starts.",
    download: true
  },
  "save-with-assets": {
    title: "Saving page with assets",
    message: "Fetching the web page now. webpocket is storing the HTML and asset folder in your local library."
  },
  "save-optimized": {
    title: "Optimizing page",
    message: "Fetching the web page now. webpocket is creating a smaller low-data reading copy."
  },
  "download-optimized": {
    title: "Preparing optimized HTML",
    message: "Fetching the web page now. Your optimized HTML download will start as soon as it is ready.",
    download: true
  },
  upload: {
    title: "Importing offline files",
    message: "Reading your selected HTML, ZIP, or assets folder now. Please keep this tab open."
  },
  remove: {
    title: "Removing saved page",
    message: "Deleting the saved files from local storage now."
  },
  "preserve-assets": {
    title: "Importing browser-saved page",
    message: "Keeping the HTML file and its assets folder together for offline reading. Please wait."
  },
  "single-html": {
    title: "Converting to single HTML",
    message: "Reading local assets from the saved browser folder and embedding them into one HTML file. Please wait."
  }
};
let pendingConfirmForm = null;
let activeForm = null;

fileInputs.forEach((input) => {
  input.addEventListener("change", () => {
    const label = input.closest("label")?.querySelector("[data-file-label]");
    if (!label) return;
    const count = input.files?.length || 0;
    label.textContent = count
      ? `${count} file${count === 1 ? "" : "s"} selected`
      : "Works with single HTML, optimized HTML, ZIP, or an assets folder.";
  });
});

function showProcessing(copy) {
  if (!processingOverlay) return;
  if (processingTitle) processingTitle.textContent = copy.title;
  if (processingMessage) processingMessage.textContent = copy.message;
  processingOverlay.hidden = false;
  document.body.classList.add("is-processing");
}

function hideProcessing() {
  if (!processingOverlay) return;
  processingOverlay.hidden = true;
  document.body.classList.remove("is-processing");
}

function setPageControlsDisabled(disabled) {
  pageControls.forEach((control) => {
    if (control.type === "hidden") return;
    if (disabled) {
      control.dataset.wasDisabled = control.disabled ? "true" : "false";
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
    } else {
      if (control.dataset.wasDisabled !== "true") control.disabled = false;
      control.removeAttribute("aria-disabled");
      delete control.dataset.wasDisabled;
    }
  });
}

function resolveSubmitter(form, event) {
  if (event.submitter) return event.submitter;
  const activeElement = document.activeElement;
  if (activeElement?.matches?.("button[type='submit'], input[type='submit']") && form.contains(activeElement)) {
    return activeElement;
  }
  return form.querySelector("button[type='submit'], input[type='submit']");
}

function formPayload(form, submitter) {
  const formData = new FormData(form);
  if (submitter?.name) {
    formData.set(submitter.name, submitter.value);
  }
  if (form.enctype === "multipart/form-data") return formData;
  return new URLSearchParams(formData);
}

function filenameFromDisposition(disposition) {
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition || "");
  if (utf8Match) return decodeURIComponent(utf8Match[1].replace(/['"]/g, ""));
  const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition || "");
  return filenameMatch ? filenameMatch[1] : "webpocket-download";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetActiveForm(form) {
  hideProcessing();
  setPageControlsDisabled(false);
  form.removeAttribute("aria-busy");
  activeForm = null;
}

function showProcessingError(form, message) {
  if (processingTitle) processingTitle.textContent = "Could not finish request";
  if (processingMessage) processingMessage.textContent = message || "Something went wrong. Please try again.";
  window.setTimeout(() => resetActiveForm(form), 2500);
}

function openConfirmDialog(form, message) {
  if (!confirmOverlay || !confirmMessage || !confirmRemove) return false;
  pendingConfirmForm = form;
  confirmMessage.textContent = message;
  confirmOverlay.hidden = false;
  document.body.classList.add("is-confirming");
  confirmRemove.focus();
  return true;
}

function closeConfirmDialog() {
  if (!confirmOverlay) return;
  confirmOverlay.hidden = true;
  document.body.classList.remove("is-confirming");
  pendingConfirmForm = null;
}

async function submitWithOverlay(form, submitter, copy) {
  const response = await fetch(form.action, {
    method: form.method || "GET",
    body: formPayload(form, submitter),
    credentials: "same-origin"
  });

  const disposition = response.headers.get("content-disposition") || "";
  const isAttachment = /attachment/i.test(disposition);

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  if (copy.download && isAttachment) {
    triggerDownload(await response.blob(), filenameFromDisposition(disposition));
    window.setTimeout(() => resetActiveForm(form), 800);
    return;
  }

  if (response.redirected) {
    window.location.assign(response.url);
    return;
  }

  window.location.reload();
}

function forgetServiceWorkers() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => undefined);
  }

  if ("caches" in window) {
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("webpocket-")).map((key) => caches.delete(key))))
      .catch(() => undefined);
  }
}

confirmCancel?.addEventListener("click", closeConfirmDialog);

confirmOverlay?.addEventListener("click", (event) => {
  if (event.target === confirmOverlay) closeConfirmDialog();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirmOverlay && !confirmOverlay.hidden) {
    closeConfirmDialog();
  }
});

confirmRemove?.addEventListener("click", () => {
  if (!pendingConfirmForm) return;
  const form = pendingConfirmForm;
  form.dataset.confirmed = "true";
  closeConfirmDialog();
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
  }
});

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (activeForm) return;

    const confirmation = form.dataset.confirm;
    if (confirmation && form.dataset.confirmed !== "true") {
      openConfirmDialog(form, confirmation);
      return;
    }
    delete form.dataset.confirmed;

    const submitter = resolveSubmitter(form, event);
    const action = form.action.includes("/delete")
      ? "remove"
      : submitter?.value || (form.enctype === "multipart/form-data" ? "upload" : "");
    const copy = processingCopy[action] || {
      title: "Processing",
      message: "Please wait while webpocket fetches and prepares your offline page."
    };

    activeForm = form;
    form.setAttribute("aria-busy", "true");
    showProcessing(copy);
    setPageControlsDisabled(true);

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        submitWithOverlay(form, submitter, copy).catch((error) => {
          showProcessingError(form, error.message);
        });
      }, 120);
    });
  });
});

window.addEventListener("load", forgetServiceWorkers);
