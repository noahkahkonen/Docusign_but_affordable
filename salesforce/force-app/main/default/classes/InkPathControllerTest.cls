@isTest
private class InkPathControllerTest {
    // Returns different bodies for the create vs. send endpoints so sendForSignature parses both.
    private class BackendMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(req.getEndpoint().endsWith('/send') ? 200 : 201);
            res.setBody(
                req.getEndpoint().endsWith('/send')
                    ? '{"requestId":"abc","links":[{"name":"Dana","email":"dana@example.com","url":"https://x/sign/t"}]}'
                    : '{"requestId":"abc","signerIds":["s1"],"docHashOriginal":"deadbeef"}'
            );
            return res;
        }
    }

    // Always returns a non-2xx error so we can assert the controller surfaces backend failures.
    // (Apex has no anonymous inner classes, so this must be a named class.)
    private class ErrorMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse r = new HttpResponse();
            r.setStatusCode(503);
            r.setBody('{"error":"salesforce_not_configured"}');
            return r;
        }
    }

    private static Id makeFileOn(Id linkedId) {
        ContentVersion cv = new ContentVersion(
            Title = 'Purchase Agreement',
            PathOnClient = 'agreement.pdf',
            VersionData = Blob.valueOf('%PDF-1.4 test')
        );
        insert cv;
        Id docId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id].ContentDocumentId;
        insert new ContentDocumentLink(
            ContentDocumentId = docId,
            LinkedEntityId = linkedId,
            ShareType = 'V',
            Visibility = 'AllUsers'
        );
        return docId;
    }

    @isTest
    static void getsRecordFiles() {
        Account a = new Account(Name = 'Acme LLC');
        insert a;
        makeFileOn(a.Id);

        Test.startTest();
        List<InkPathController.FileOption> files = InkPathController.getRecordFiles(a.Id);
        Test.stopTest();

        System.assertEquals(1, files.size(), 'Expected one file on the record');
        System.assertEquals(true, files[0].isPdf, 'agreement.pdf should be flagged as PDF');
        System.assertNotEquals(null, files[0].contentVersionId);
    }

    @isTest
    static void suggestsSignersForAccount() {
        Account a = new Account(Name = 'Acme LLC');
        insert a;
        insert new Contact(LastName = 'Chaykin', Email = 'robert@example.com', AccountId = a.Id);

        Test.startTest();
        List<InkPathController.SignerSuggestion> s = InkPathController.getSuggestedSigners(a.Id);
        Test.stopTest();

        System.assertEquals(1, s.size());
        System.assertEquals('robert@example.com', s[0].email);
    }

    @isTest
    static void suggestsSignersForContact() {
        Contact c = new Contact(LastName = 'Chaykin', Email = 'robert@example.com');
        insert c;

        Test.startTest();
        List<InkPathController.SignerSuggestion> s = InkPathController.getSuggestedSigners(c.Id);
        Test.stopTest();

        System.assertEquals(1, s.size());
        System.assertEquals('robert@example.com', s[0].email);
    }

    @isTest
    static void suggestsSignersForLead() {
        Lead l = new Lead(LastName = 'Broker', Company = 'Acme', Email = 'lead@example.com');
        insert l;

        Test.startTest();
        List<InkPathController.SignerSuggestion> s = InkPathController.getSuggestedSigners(l.Id);
        Test.stopTest();

        System.assertEquals(1, s.size());
        System.assertEquals('lead@example.com', s[0].email);
    }

    @isTest
    static void suggestsSignersForOpportunity() {
        Account a = new Account(Name = 'Acme LLC');
        insert a;
        Contact c = new Contact(LastName = 'Seller', Email = 'seller@example.com', AccountId = a.Id);
        insert c;
        Opportunity o = new Opportunity(
            Name = '123 Main St Deal',
            StageName = 'Prospecting',
            CloseDate = Date.today().addDays(30),
            AccountId = a.Id
        );
        insert o;
        insert new OpportunityContactRole(OpportunityId = o.Id, ContactId = c.Id, IsPrimary = true);

        Test.startTest();
        List<InkPathController.SignerSuggestion> s = InkPathController.getSuggestedSigners(o.Id);
        Test.stopTest();

        System.assertEquals(1, s.size());
        System.assertEquals('seller@example.com', s[0].email);
    }

    @isTest
    static void sendsForSignature() {
        Account a = new Account(Name = 'Acme LLC');
        insert a;
        Id docId = makeFileOn(a.Id);
        Id cvId = [SELECT LatestPublishedVersionId FROM ContentDocument WHERE Id = :docId].LatestPublishedVersionId;

        String signers = JSON.serialize(new List<Object>{
            new Map<String, Object>{
                'name' => 'Dana Broker',
                'email' => 'dana@example.com',
                'autoFields' => new List<String>{ 'SIGNATURE', 'DATE', 'TEXT' }
            }
        });

        Test.setMock(HttpCalloutMock.class, new BackendMock());
        Test.startTest();
        String body = InkPathController.sendForSignature(a.Id, cvId, 'Purchase Agreement.pdf', signers);
        Test.stopTest();

        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(body);
        System.assertEquals('abc', parsed.get('requestId'));
        System.assert(parsed.containsKey('links'), 'Response should include signing links');
    }

    @isTest
    static void surfacesBackendErrors() {
        Account a = new Account(Name = 'Acme LLC');
        insert a;

        Test.setMock(HttpCalloutMock.class, new ErrorMock());

        Boolean threw = false;
        Test.startTest();
        try {
            InkPathController.sendForSignature(a.Id, '068000000000000AAA', 'doc.pdf', '[]');
        } catch (AuraHandledException e) {
            threw = true;
        }
        Test.stopTest();
        System.assertEquals(true, threw, 'A non-2xx backend response should raise an error');
    }
}
