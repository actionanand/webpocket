const fileInputs = document.querySelectorAll("input[type='file']");
const processingOverlay = document.querySelector("[data-processing-overlay]");
const processingTitle = document.querySelector("[data-processing-title]");
const processingMessage = document.querySelector("[data-processing-message]");
const confirmOverlay = document.querySelector("[data-confirm-overlay]");
const confirmMessage = document.querySelector("[data-confirm-message]");
const confirmCancel = document.querySelector("[data-confirm-cancel]");
const confirmRemove = document.querySelector("[data-confirm-remove]");
const submitControls = document.querySelectorAll("button[type='submit'], input[type='submit']");

const processingCopy = {
  "save-single": {
    title: "Saving single page",
    message: "Fetching the web page and embedding styles, images, icons, and CSS assets for offline reading. Please wait."
  },
  "download-html": {
    title: "Preparing single HTML",
    message: "Fetching the web page and creating one standalone HTML file. The download should begin shortly.",
    download: true
  },
  "download-zip": {
    title: "Preparing ZIP package",
    message: "Fetching the web page assets and packaging them with index.html. Larger pages can take longer.",
    download: true
  },
  "save-with-assets": {
    title: "Saving page with assets",
    message: "Fetching the web page and storing its assets folder in your local webpocket library. Please wait."
  },
  "save-optimized": {
    title: "Optimizing page",
    message: "Fetching the web page and creating a smaller low-data reading copy. Please wait."
  },
  "download-optimized": {
    title: "Preparing optimized HTML",
    message: "Fetching the web page and creating a smaller low-data HTML file. The download should begin shortly.",
    download: true
  },
  upload: {
    title: "Importing offline files",
    message: "Reading your selected HTML, ZIP, or assets folder and adding it to the local library. Please wait."
  },
  remove: {
    title: "Removing saved page",
    message: "Deleting the saved files from local storage. Please wait."
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

function addSubmitterValue(form, submitter) {
  if (!submitter?.name) return;
  const existing = form.querySelector(`input[type="hidden"][name="${submitter.name}"][data-submit-value]`);
  if (existing) existing.remove();
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = submitter.name;
  hidden.value = submitter.value;
  hidden.dataset.submitValue = "true";
  form.append(hidden);
}

function setSubmitControlsDisabled(disabled) {
  submitControls.forEach((control) => {
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

function submitAfterPaint(form) {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      HTMLFormElement.prototype.submit.call(form);
    }, 80);
  });
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

function resolveSubmitter(form, event) {
  if (event.submitter) return event.submitter;
  const activeElement = document.activeElement;
  if (activeElement?.matches?.("button[type='submit'], input[type='submit']") && form.contains(activeElement)) {
    return activeElement;
  }
  return form.querySelector("button[type='submit'], input[type='submit']");
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
    if (form.dispatchEvent(submitEvent)) {
      HTMLFormElement.prototype.submit.call(form);
    }
  }
});

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (activeForm) {
      event.preventDefault();
      return;
    }

    const confirmation = form.dataset.confirm;
    if (confirmation && form.dataset.confirmed !== "true") {
      event.preventDefault();
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

    event.preventDefault();
    addSubmitterValue(form, submitter);
    showProcessing(copy);
    setSubmitControlsDisabled(true);
    form.setAttribute("aria-busy", "true");
    form.dataset.submitting = "true";
    activeForm = form;
    submitAfterPaint(form);

    if (copy.download) {
      window.setTimeout(() => {
        hideProcessing();
        setSubmitControlsDisabled(false);
        form.removeAttribute("aria-busy");
        delete form.dataset.submitting;
        activeForm = null;
      }, 30000);
    }
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
