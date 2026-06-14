@RestResource(urlMapping='/inkpath/webhook/*')
global with sharing class InkPathWebhook {

    @HttpPost
    global static void handle() {
        RestRequest req = RestContext.request;
        RestResponse res = RestContext.response;
        Blob body = req.requestBody;
        String bodyStr = (body == null) ? '' : body.toString();

        String secret = InkPathService.getWebhookSecret();
        if (String.isBlank(secret) || secret == 'REPLACE_ME') {
            respond(res, 503, '{"error":"webhook secret not configured"}');
            return;
        }
        String provided = req.headers.get('X-InkPath-Signature');
        if (String.isBlank(provided)) {
            respond(res, 401, '{"error":"missing signature"}');
            return;
        }
        String expected = 'sha256=' + EncodingUtil.convertToHex(
            Crypto.generateMac('hmacSHA256', body, Blob.valueOf(secret))
        );
        if (!secureEquals(expected, provided)) {
            respond(res, 401, '{"error":"invalid signature"}');
            return;
        }

        Map<String, Object> p;
        try {
            p = (Map<String, Object>) JSON.deserializeUntyped(bodyStr);
        } catch (Exception e) {
            respond(res, 400, '{"error":"invalid json"}');
            return;
        }
        String token = (String) p.get('token');
        if (String.isBlank(token)) {
            respond(res, 400, '{"error":"token required"}');
            return;
        }

        List<InkPath_Signature_Request__c> rows = [
            SELECT Id, Status__c
            FROM InkPath_Signature_Request__c
            WHERE Request_Token__c = :token
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            respond(res, 404, '{"error":"unknown token"}');
            return;
        }
        InkPath_Signature_Request__c rec = rows[0];
        rec.Status__c = 'Signed';
        rec.Signed_At__c = parseIso((String) p.get('signed_at'));
        rec.Signed_IP__c = (String) p.get('signed_ip');
        rec.Signature_Type__c = capitalize((String) p.get('signature_type'));
        update rec;

        respond(res, 200, '{"ok":true}');
    }

    private static void respond(RestResponse res, Integer status, String body) {
        res.statusCode = status;
        res.headers.put('Content-Type', 'application/json');
        res.responseBody = Blob.valueOf(body);
    }

    private static Boolean secureEquals(String a, String b) {
        if (a == null || b == null) return false;
        if (a.length() != b.length()) return false;
        Integer r = 0;
        for (Integer i = 0; i < a.length(); i++) {
            r |= a.charAt(i) ^ b.charAt(i);
        }
        return r == 0;
    }

    private static DateTime parseIso(String s) {
        if (String.isBlank(s)) return null;
        try {
            return (DateTime) JSON.deserialize('"' + s + '"', DateTime.class);
        } catch (Exception e) {
            return null;
        }
    }

    private static String capitalize(String s) {
        if (String.isBlank(s)) return s;
        return s.substring(0, 1).toUpperCase() + s.substring(1).toLowerCase();
    }
}
