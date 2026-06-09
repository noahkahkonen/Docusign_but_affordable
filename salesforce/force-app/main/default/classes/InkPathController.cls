/**
 * Server-side controller for the "Send for Signature" LWC.
 *
 * Reads the record's Files + suggested signers natively (no callout), and sends a signature
 * request to the InkPath backend over a Named Credential ("InkPath_Backend") so no secret ever
 * lives in Apex. The backend's API-key guard is satisfied by a custom header on the linked
 * External Credential — see salesforce/README.md for setup.
 */
public with sharing class InkPathController {
    @TestVisible
    private static final String NAMED_CREDENTIAL = 'callout:InkPath_Backend';

    // ---- Files on the record ---------------------------------------------------------------

    public class FileOption implements Comparable {
        @AuraEnabled public String contentVersionId;
        @AuraEnabled public String contentDocumentId;
        @AuraEnabled public String title;
        @AuraEnabled public String fileExtension;
        @AuraEnabled public Datetime modifiedDate;
        @AuraEnabled public Boolean isPdf;

        // Newest first. ContentDocumentLink queries can't ORDER BY (see getRecordFiles), so the
        // list is sorted in Apex via List.sort() using this comparator.
        public Integer compareTo(Object other) {
            Datetime otherDate = ((FileOption) other).modifiedDate;
            if (modifiedDate == otherDate) return 0;
            return modifiedDate > otherDate ? -1 : 1;
        }
    }

    @AuraEnabled(cacheable=true)
    public static List<FileOption> getRecordFiles(Id recordId) {
        List<FileOption> files = new List<FileOption>();
        // NB: a ContentDocumentLink query bounded by LinkedEntityId does NOT support ORDER BY — it
        // throws System.QueryException (MALFORMED_QUERY) at runtime. We sort in Apex below instead.
        // Record visibility is governed by `with sharing`; field exposure here is non-sensitive
        // file metadata (title/extension/dates).
        for (ContentDocumentLink link : [
            SELECT ContentDocumentId,
                   ContentDocument.Title,
                   ContentDocument.LatestPublishedVersionId,
                   ContentDocument.FileExtension,
                   ContentDocument.ContentModifiedDate
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :recordId
        ]) {
            String ext = link.ContentDocument.FileExtension;
            FileOption f = new FileOption();
            f.contentVersionId = link.ContentDocument.LatestPublishedVersionId;
            f.contentDocumentId = link.ContentDocumentId;
            f.title = link.ContentDocument.Title;
            f.fileExtension = ext;
            f.modifiedDate = link.ContentDocument.ContentModifiedDate;
            f.isPdf = ext != null && ext.equalsIgnoreCase('pdf');
            files.add(f);
        }
        files.sort(); // newest first (FileOption.compareTo)
        return files;
    }

    // ---- Suggested signers (pre-fill) ------------------------------------------------------

    public class SignerSuggestion {
        @AuraEnabled public String name;
        @AuraEnabled public String email;
    }

    @AuraEnabled(cacheable=true)
    public static List<SignerSuggestion> getSuggestedSigners(Id recordId) {
        List<SignerSuggestion> out = new List<SignerSuggestion>();
        String objectType = recordId.getSObjectType().getDescribe().getName();

        // WITH USER_MODE enforces the running user's object + field-level security (FLS), so a user
        // without read access to Name/Email never has that PII surfaced through this controller —
        // `with sharing` alone only enforces record sharing, not FLS.
        if (objectType == 'Contact') {
            for (Contact c : [SELECT Name, Email FROM Contact WHERE Id = :recordId AND Email != null WITH USER_MODE]) {
                out.add(suggestion(c.Name, c.Email));
            }
        } else if (objectType == 'Lead') {
            for (Lead l : [SELECT Name, Email FROM Lead WHERE Id = :recordId AND Email != null WITH USER_MODE]) {
                out.add(suggestion(l.Name, l.Email));
            }
        } else if (objectType == 'Account') {
            for (Contact c : [
                SELECT Name, Email FROM Contact
                WHERE AccountId = :recordId AND Email != null
                WITH USER_MODE
                ORDER BY LastModifiedDate DESC LIMIT 25
            ]) {
                out.add(suggestion(c.Name, c.Email));
            }
        } else if (objectType == 'Opportunity') {
            for (OpportunityContactRole r : [
                SELECT Contact.Name, Contact.Email FROM OpportunityContactRole
                WHERE OpportunityId = :recordId AND Contact.Email != null
                WITH USER_MODE
            ]) {
                out.add(suggestion(r.Contact.Name, r.Contact.Email));
            }
        }
        // Other objects (e.g. TTL_Core__Deal__c): no automatic suggestion; the user enters signers.
        return out;
    }

    private static SignerSuggestion suggestion(String name, String email) {
        SignerSuggestion s = new SignerSuggestion();
        s.name = name;
        s.email = email;
        return s;
    }

    // ---- Send for signature (callout to backend) -------------------------------------------

    /**
     * @param signersJson JSON array of { name, email, entityLabel?, autoFields: [..] } objects.
     * @return the backend "send" response body: { requestId, links: [{ name, email, url }] }.
     */
    @AuraEnabled
    public static String sendForSignature(
        Id recordId,
        String contentVersionId,
        String documentName,
        String signersJson
    ) {
        String objectType = recordId.getSObjectType().getDescribe().getName();

        Map<String, Object> createBody = new Map<String, Object>{
            'salesforceRecordId' => String.valueOf(recordId),
            'salesforceObjectType' => objectType,
            'contentVersionId' => contentVersionId,
            'documentName' => documentName,
            'signers' => (List<Object>) JSON.deserializeUntyped(signersJson)
        };

        HttpResponse createRes = doCallout('/api/requests', JSON.serialize(createBody));
        if (createRes.getStatusCode() < 200 || createRes.getStatusCode() >= 300) {
            throw new AuraHandledException(
                'Could not create the signature request (' + createRes.getStatusCode() + '): ' + createRes.getBody()
            );
        }
        Map<String, Object> created = (Map<String, Object>) JSON.deserializeUntyped(createRes.getBody());
        String requestId = (String) created.get('requestId');

        HttpResponse sendRes = doCallout('/api/requests/' + requestId + '/send', '{}');
        if (sendRes.getStatusCode() < 200 || sendRes.getStatusCode() >= 300) {
            throw new AuraHandledException(
                'Could not send the signature request (' + sendRes.getStatusCode() + '): ' + sendRes.getBody()
            );
        }
        return sendRes.getBody();
    }

    private static HttpResponse doCallout(String path, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(NAMED_CREDENTIAL + path);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(body);
        return new Http().send(req);
    }
}
