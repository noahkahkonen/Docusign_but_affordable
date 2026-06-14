import { LightningElement, api, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getRecordFiles from '@salesforce/apex/InkPathService.getRecordFiles';
import getRequestsForRecord from '@salesforce/apex/InkPathService.getRequestsForRecord';
import sendForSignature from '@salesforce/apex/InkPathService.sendForSignature';

export default class InkPathSendForSignature extends LightningElement {
    @api recordId;

    selectedFileId;
    signerName = '';
    signerEmail = '';
    sending = false;
    lastSigningUrl;
    loadError;

    _filesResult;
    _requestsResult;
    _files = [];
    _requests = [];

    @wire(getRecordFiles, { recordId: '$recordId' })
    wiredFiles(result) {
        this._filesResult = result;
        if (result.error) {
            this.loadError = this.errorMessage(result.error);
        } else if (result.data) {
            this._files = result.data;
            this.loadError = undefined;
        }
    }

    @wire(getRequestsForRecord, { recordId: '$recordId' })
    wiredRequests(result) {
        this._requestsResult = result;
        if (result.data) this._requests = result.data;
    }

    get hasFiles() {
        return this._files && this._files.length > 0;
    }

    get fileOptions() {
        return (this._files || []).map(f => ({
            label: `${f.title}.${f.fileExtension}`,
            value: f.id
        }));
    }

    get hasRequests() {
        return this._requests && this._requests.length > 0;
    }

    get requestList() {
        return (this._requests || []).map(r => ({
            ...r,
            signedAtDisplay: r.Signed_At__c ? new Date(r.Signed_At__c).toLocaleString() : '',
            badgeClass: r.Status__c === 'Signed' ? 'slds-theme_success' :
                        r.Status__c === 'Sent'   ? 'slds-theme_warning' :
                        r.Status__c === 'Voided' ? 'slds-theme_error'   : ''
        }));
    }

    handleFileChange(e)        { this.selectedFileId = e.detail.value; }
    handleSignerNameChange(e)  { this.signerName = e.detail.value; }
    handleSignerEmailChange(e) { this.signerEmail = e.detail.value; }

    async handleSend() {
        if (!this.selectedFileId || !this.signerName || !this.signerEmail) {
            this.toast('Missing fields', 'Pick a document and enter signer name and email.', 'warning');
            return;
        }
        this.sending = true;
        this.lastSigningUrl = undefined;
        try {
            const result = await sendForSignature({
                recordId: this.recordId,
                contentVersionId: this.selectedFileId,
                signerName: this.signerName,
                signerEmail: this.signerEmail
            });
            this.lastSigningUrl = result.signingUrl;
            this.toast('Sent', 'Signing link created.', 'success');
            this.signerName = '';
            this.signerEmail = '';
            this.selectedFileId = null;
            await refreshApex(this._requestsResult);
        } catch (err) {
            this.toast('Send failed', this.errorMessage(err), 'error');
        } finally {
            this.sending = false;
        }
    }

    async handleCopy() {
        if (!this.lastSigningUrl) return;
        try {
            await navigator.clipboard.writeText(this.lastSigningUrl);
            this.toast('Copied', 'Signing link copied to clipboard.', 'success');
        } catch {
            this.toast('Copy failed', 'Clipboard not available. Copy manually from the field above.', 'warning');
        }
    }

    handleOpen() {
        if (this.lastSigningUrl) window.open(this.lastSigningUrl, '_blank', 'noopener');
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    errorMessage(err) {
        if (err && err.body && err.body.message) return err.body.message;
        if (err && err.message) return err.message;
        return 'Unknown error';
    }
}
