import { LightningElement, api, wire } from "lwc";
import { ShowToastEvent } from "lightning/platformShowToastEvent";
import getRecordFiles from "@salesforce/apex/InkPathController.getRecordFiles";
import getSuggestedSigners from "@salesforce/apex/InkPathController.getSuggestedSigners";
import sendForSignature from "@salesforce/apex/InkPathController.sendForSignature";

const FIELD_TYPES = [
  { type: "SIGNATURE", label: "Signature" },
  { type: "DATE", label: "Date" },
  { type: "TEXT", label: "Title" },
];

function newSigner(name = "", email = "") {
  return { name, email, entityLabel: "", fields: { SIGNATURE: true, DATE: true, TEXT: false } };
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (Array.isArray(error.body)) return error.body.map((e) => e.message).join(", ");
  if (error.body && error.body.message) return error.body.message;
  return error.message || JSON.stringify(error);
}

export default class SendForSignature extends LightningElement {
  @api recordId;

  files = [];
  signers = [newSigner()];
  selectedFileId;
  loadingFiles = true;
  sending = false;
  result;
  error;

  @wire(getRecordFiles, { recordId: "$recordId" })
  wiredFiles({ data, error }) {
    if (data) {
      this.files = data;
      const preferred = data.find((f) => f.isPdf) || data[0];
      this.selectedFileId = preferred ? preferred.contentVersionId : undefined;
      this.loadingFiles = false;
    } else if (error) {
      this.error = errorMessage(error);
      this.loadingFiles = false;
    }
  }

  @wire(getSuggestedSigners, { recordId: "$recordId" })
  wiredSigners({ data }) {
    if (data && data.length) {
      this.signers = data.map((s) => newSigner(s.name, s.email));
    }
  }

  // ---- derived view state ----
  get hasFiles() {
    return this.files.length > 0;
  }

  get fileOptions() {
    return this.files.map((f) => ({
      label: f.isPdf ? f.title : `${f.title} (not a PDF)`,
      value: f.contentVersionId,
    }));
  }

  get selectedFile() {
    return this.files.find((f) => f.contentVersionId === this.selectedFileId);
  }

  get documentName() {
    const f = this.selectedFile;
    return f ? `${f.title}.${f.fileExtension || "pdf"}` : "";
  }

  get selectedNotPdf() {
    const f = this.selectedFile;
    return f && !f.isPdf;
  }

  get signerRows() {
    return this.signers.map((s, index) => ({
      index,
      name: s.name,
      email: s.email,
      entityLabel: s.entityLabel,
      removable: this.signers.length > 1,
      fieldChecks: FIELD_TYPES.map((ft) => ({
        key: `${index}-${ft.type}`,
        type: ft.type,
        label: ft.label,
        checked: !!s.fields[ft.type],
      })),
    }));
  }

  get canSend() {
    return (
      !!this.selectedFileId &&
      !this.sending &&
      this.signers.length > 0 &&
      this.signers.every((s) => s.name && s.email && Object.values(s.fields).some(Boolean))
    );
  }

  get sendDisabled() {
    return !this.canSend;
  }

  // ---- handlers ----
  handleFileChange(event) {
    this.selectedFileId = event.detail.value;
  }

  handleSignerInput(event) {
    const index = Number(event.target.dataset.index);
    const field = event.target.dataset.field;
    this.signers[index][field] = event.target.value;
  }

  handleFieldToggle(event) {
    const index = Number(event.target.dataset.index);
    const type = event.target.dataset.type;
    this.signers[index].fields[type] = event.target.checked;
    this.signers = [...this.signers];
  }

  addSigner() {
    this.signers = [...this.signers, newSigner()];
  }

  removeSigner(event) {
    const index = Number(event.target.dataset.index);
    this.signers = this.signers.filter((_, i) => i !== index);
  }

  async handleSend() {
    this.sending = true;
    this.error = undefined;
    const payload = this.signers.map((s) => ({
      name: s.name,
      email: s.email,
      entityLabel: s.entityLabel || undefined,
      autoFields: Object.keys(s.fields).filter((k) => s.fields[k]),
    }));
    try {
      const body = await sendForSignature({
        recordId: this.recordId,
        contentVersionId: this.selectedFileId,
        documentName: this.documentName,
        signersJson: JSON.stringify(payload),
      });
      this.result = JSON.parse(body);
      this.dispatchEvent(
        new ShowToastEvent({
          title: "Sent for signature",
          message: `${this.result.links.length} signing link(s) created.`,
          variant: "success",
        }),
      );
    } catch (e) {
      this.error = errorMessage(e);
    } finally {
      this.sending = false;
    }
  }

  get sentLinks() {
    return this.result ? this.result.links : [];
  }
}
