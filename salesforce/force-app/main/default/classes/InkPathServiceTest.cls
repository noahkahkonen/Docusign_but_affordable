@IsTest
private class InkPathServiceTest {

    private static final String API_KEY = 'unit-test-key';
    private static final String WEBHOOK_SECRET = 'unit-test-secret';

    private class SendOkMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse r = new HttpResponse();
            r.setStatusCode(200);
            r.setHeader('Content-Type', 'application/json');
            r.setBody('{"request_id":"ext-req-1","document_id":"doc-1","token":"tkn-abc","signing_url":"https://example.test/sign/tkn-abc"}');
            return r;
        }
    }

    private class SendFailMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse r = new HttpResponse();
            r.setStatusCode(401);
            r.setBody('{"error":"Unauthorized"}');
            return r;
        }
    }

    private static Id createTestContentVersion() {
        ContentVersion cv = new ContentVersion(
            Title = 'Unit Test Doc',
            PathOnClient = 'Unit Test Doc.pdf',
            VersionData = Blob.valueOf('%PDF-1.1 fake')
        );
        insert cv;
        return [SELECT Id FROM ContentVersion WHERE Id = :cv.Id].Id;
    }

    @IsTest
    static void sendForSignature_persistsRequest() {
        InkPathService.overrideApiKey = API_KEY;
        Id cvId = createTestContentVersion();
        Test.setMock(HttpCalloutMock.class, new SendOkMock());

        Test.startTest();
        InkPathService.SendResult result = InkPathService.sendForSignature(
            UserInfo.getUserId(), cvId, 'Jane Signer', 'jane@example.com'
        );
        Test.stopTest();

        System.assertEquals('tkn-abc', result.token);
        System.assertEquals('https://example.test/sign/tkn-abc', result.signingUrl);

        InkPath_Signature_Request__c row = [
            SELECT Status__c, Request_Token__c, Document_Name__c, Signer_Email__c, Related_Record_Id__c
            FROM InkPath_Signature_Request__c
            WHERE Id = :result.requestId
        ];
        System.assertEquals('Sent', row.Status__c);
        System.assertEquals('tkn-abc', row.Request_Token__c);
        System.assertEquals('jane@example.com', row.Signer_Email__c);
        System.assertEquals(String.valueOf(UserInfo.getUserId()), row.Related_Record_Id__c);
    }

    @IsTest
    static void sendForSignature_missingApiKeyThrows() {
        InkPathService.overrideApiKey = '';
        Id cvId = createTestContentVersion();
        Test.startTest();
        try {
            InkPathService.sendForSignature(UserInfo.getUserId(), cvId, 'Jane', 'jane@example.com');
            System.assert(false, 'expected exception');
        } catch (AuraHandledException e) {
            // expected
        }
        Test.stopTest();
    }

    @IsTest
    static void sendForSignature_httpFailureThrows() {
        InkPathService.overrideApiKey = API_KEY;
        Id cvId = createTestContentVersion();
        Test.setMock(HttpCalloutMock.class, new SendFailMock());
        Test.startTest();
        try {
            InkPathService.sendForSignature(UserInfo.getUserId(), cvId, 'Jane', 'jane@example.com');
            System.assert(false, 'expected exception');
        } catch (AuraHandledException e) {
            // expected
        }
        Test.stopTest();
    }

    @IsTest
    static void getRecordFiles_returnsOnlyAllowedTypes() {
        // Create one PDF file linked to the running user, and one .xlsx that should be filtered out
        ContentVersion pdf = new ContentVersion(Title='Allowed', PathOnClient='Allowed.pdf', VersionData=Blob.valueOf('a'));
        ContentVersion xls = new ContentVersion(Title='Blocked', PathOnClient='Blocked.xlsx', VersionData=Blob.valueOf('b'));
        insert new List<ContentVersion>{ pdf, xls };
        List<ContentVersion> reloaded = [SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id IN :new Set<Id>{pdf.Id, xls.Id}];
        List<ContentDocumentLink> links = new List<ContentDocumentLink>();
        for (ContentVersion cv : reloaded) {
            links.add(new ContentDocumentLink(
                ContentDocumentId = cv.ContentDocumentId,
                LinkedEntityId = UserInfo.getUserId(),
                ShareType = 'V'
            ));
        }
        insert links;

        List<InkPathService.FileOption> opts = InkPathService.getRecordFiles(UserInfo.getUserId());
        Boolean foundAllowed = false;
        for (InkPathService.FileOption f : opts) {
            System.assertNotEquals('xlsx', f.fileExtension.toLowerCase(), 'xlsx should be filtered out');
            if (f.title == 'Allowed') foundAllowed = true;
        }
        System.assert(foundAllowed, 'PDF should be returned');
    }

    @IsTest
    static void webhook_validSignatureMarksSigned() {
        InkPathService.overrideWebhookSecret = WEBHOOK_SECRET;
        InkPath_Signature_Request__c rec = new InkPath_Signature_Request__c(
            Status__c = 'Sent',
            Request_Token__c = 'tkn-xyz',
            Signer_Email__c = 'x@example.com',
            Document_Name__c = 'Doc'
        );
        insert rec;

        String body = '{"token":"tkn-xyz","signed_at":"2026-01-15T10:00:00Z","signed_ip":"1.2.3.4","signature_type":"typed"}';
        Blob bodyBlob = Blob.valueOf(body);
        String sig = 'sha256=' + EncodingUtil.convertToHex(
            Crypto.generateMac('hmacSHA256', bodyBlob, Blob.valueOf(WEBHOOK_SECRET))
        );

        RestRequest req = new RestRequest();
        req.requestBody = bodyBlob;
        req.headers.put('X-InkPath-Signature', sig);
        req.requestURI = '/services/apexrest/inkpath/webhook';
        req.httpMethod = 'POST';
        RestContext.request = req;
        RestContext.response = new RestResponse();

        Test.startTest();
        InkPathWebhook.handle();
        Test.stopTest();

        System.assertEquals(200, RestContext.response.statusCode);
        InkPath_Signature_Request__c updated = [
            SELECT Status__c, Signed_IP__c, Signature_Type__c FROM InkPath_Signature_Request__c WHERE Id = :rec.Id
        ];
        System.assertEquals('Signed', updated.Status__c);
        System.assertEquals('1.2.3.4', updated.Signed_IP__c);
        System.assertEquals('Typed', updated.Signature_Type__c);
    }

    @IsTest
    static void webhook_invalidSignatureRejected() {
        InkPathService.overrideWebhookSecret = WEBHOOK_SECRET;
        RestRequest req = new RestRequest();
        req.requestBody = Blob.valueOf('{"token":"any"}');
        req.headers.put('X-InkPath-Signature', 'sha256=nope');
        RestContext.request = req;
        RestContext.response = new RestResponse();
        Test.startTest();
        InkPathWebhook.handle();
        Test.stopTest();
        System.assertEquals(401, RestContext.response.statusCode);
    }

    @IsTest
    static void webhook_missingSecretReturns503() {
        InkPathService.overrideWebhookSecret = '';
        RestRequest req = new RestRequest();
        req.requestBody = Blob.valueOf('{"token":"any"}');
        req.headers.put('X-InkPath-Signature', 'sha256=abc');
        RestContext.request = req;
        RestContext.response = new RestResponse();
        Test.startTest();
        InkPathWebhook.handle();
        Test.stopTest();
        System.assertEquals(503, RestContext.response.statusCode);
    }
}
