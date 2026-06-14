public with sharing class InkPathService {

    public class SendResult {
        @AuraEnabled public String requestId;
        @AuraEnabled public String token;
        @AuraEnabled public String signingUrl;
    }

    public class FileOption {
        @AuraEnabled public String id;
        @AuraEnabled public String title;
        @AuraEnabled public String fileExtension;
        @AuraEnabled public Integer contentSize;
    }

    @TestVisible private static String overrideApiKey;
    @TestVisible private static String overrideWebhookSecret;

    public static String getApiKey() {
        if (overrideApiKey != null) return overrideApiKey;
        InkPath_Setting__mdt s = InkPath_Setting__mdt.getInstance('Default');
        return s == null ? null : s.API_Key__c;
    }

    public static String getWebhookSecret() {
        if (overrideWebhookSecret != null) return overrideWebhookSecret;
        InkPath_Setting__mdt s = InkPath_Setting__mdt.getInstance('Default');
        return s == null ? null : s.Webhook_Secret__c;
    }

    @AuraEnabled(cacheable=true)
    public static List<FileOption> getRecordFiles(Id recordId) {
        List<FileOption> out = new List<FileOption>();
        List<ContentDocumentLink> links = [
            SELECT ContentDocumentId
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :recordId
        ];
        if (links.isEmpty()) return out;
        Set<Id> docIds = new Set<Id>();
        for (ContentDocumentLink l : links) docIds.add(l.ContentDocumentId);
        Set<String> allowed = new Set<String>{ 'pdf', 'png', 'jpg', 'jpeg' };
        for (ContentVersion v : [
            SELECT Id, Title, FileExtension, ContentSize
            FROM ContentVersion
            WHERE ContentDocumentId IN :docIds AND IsLatest = true
            ORDER BY CreatedDate DESC
        ]) {
            String ext = v.FileExtension == null ? '' : v.FileExtension.toLowerCase();
            if (!allowed.contains(ext)) continue;
            FileOption f = new FileOption();
            f.id = v.Id;
            f.title = v.Title;
            f.fileExtension = v.FileExtension;
            f.contentSize = v.ContentSize;
            out.add(f);
        }
        return out;
    }

    @AuraEnabled(cacheable=true)
    public static List<InkPath_Signature_Request__c> getRequestsForRecord(Id recordId) {
        return [
            SELECT Id, Name, Status__c, Signing_URL__c, Signer_Name__c, Signer_Email__c,
                   Document_Name__c, Signed_At__c, Signed_IP__c, Signature_Type__c, CreatedDate
            FROM InkPath_Signature_Request__c
            WHERE Related_Record_Id__c = :String.valueOf(recordId)
            ORDER BY CreatedDate DESC
            LIMIT 50
        ];
    }

    @AuraEnabled
    public static SendResult sendForSignature(Id recordId, Id contentVersionId, String signerName, String signerEmail) {
        if (String.isBlank(signerName)) throw new AuraHandledException('Signer name required');
        if (String.isBlank(signerEmail)) throw new AuraHandledException('Signer email required');
        if (contentVersionId == null) throw new AuraHandledException('Document required');

        ContentVersion cv = [
            SELECT Id, Title, FileExtension, VersionData
            FROM ContentVersion
            WHERE Id = :contentVersionId
            LIMIT 1
        ];
        String mime = mimeForExtension(cv.FileExtension);
        if (mime == null) throw new AuraHandledException('Only PDF, PNG, and JPEG files are supported.');

        String apiKey = getApiKey();
        if (String.isBlank(apiKey) || apiKey == 'REPLACE_ME') {
            throw new AuraHandledException('InkPath API key is not configured. Edit the InkPath Setting "Default" Custom Metadata record.');
        }

        Map<String, Object> payload = new Map<String, Object>{
            'title' => cv.Title,
            'filename' => cv.Title + '.' + cv.FileExtension,
            'mime_type' => mime,
            'content_base64' => EncodingUtil.base64Encode(cv.VersionData),
            'signer_name' => signerName.trim(),
            'signer_email' => signerEmail.trim(),
            'sender_name' => UserInfo.getName(),
            'sender_email' => UserInfo.getUserEmail(),
            'external_ref' => String.valueOf(recordId),
            'webhook_url' => Url.getOrgDomainUrl().toExternalForm() + '/services/apexrest/inkpath/webhook'
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:InkPath_API/api/v1/documents');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Authorization', 'Bearer ' + apiKey);
        req.setTimeout(60000);
        req.setBody(JSON.serialize(payload));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() < 200 || res.getStatusCode() >= 300) {
            throw new AuraHandledException('InkPath returned HTTP ' + res.getStatusCode() + ': ' + res.getBody());
        }

        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        String token = (String) body.get('token');
        String signingUrl = (String) body.get('signing_url');
        String externalReqId = (String) body.get('request_id');

        InkPath_Signature_Request__c rec = new InkPath_Signature_Request__c(
            Status__c = 'Sent',
            Signing_URL__c = signingUrl,
            Signer_Name__c = signerName.trim(),
            Signer_Email__c = signerEmail.trim(),
            Document_Name__c = cv.Title,
            Request_Token__c = token,
            External_Request_Id__c = externalReqId,
            Related_Record_Id__c = String.valueOf(recordId)
        );
        insert rec;

        SendResult out = new SendResult();
        out.requestId = rec.Id;
        out.token = token;
        out.signingUrl = signingUrl;
        return out;
    }

    private static String mimeForExtension(String ext) {
        if (String.isBlank(ext)) return null;
        String e = ext.toLowerCase();
        if (e == 'pdf') return 'application/pdf';
        if (e == 'png') return 'image/png';
        if (e == 'jpg' || e == 'jpeg') return 'image/jpeg';
        return null;
    }
}
