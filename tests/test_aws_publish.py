"""Publication permissions and the container's private HTTP boundary."""
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('smoke_container_http', ROOT/'scripts/smoke_container_http.py')
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


def response(value, status=200):
    body = io.BytesIO(json.dumps(value).encode())
    body.status = status
    return body


def unauthorized(private=True):
    headers = Message()
    if private:
        headers['Cache-Control'] = 'private,no-store'
    return HTTPError('http://127.0.0.1:8787/api/bootstrap', 401, 'Sign in', headers, io.BytesIO())


class AwsPublishTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((ROOT/'infra/aws/registry.json').read_text())

    def test_registry_keeps_release_images_private_immutable_and_retained(self):
        repository = self.template['Resources']['Repository']
        self.assertEqual(repository['Type'], 'AWS::ECR::Repository')
        self.assertEqual(repository['DeletionPolicy'], 'Retain')
        self.assertEqual(repository['UpdateReplacePolicy'], 'Retain')
        properties = repository['Properties']
        self.assertEqual(properties['ImageTagMutability'], 'IMMUTABLE')
        self.assertTrue(properties['ImageScanningConfiguration']['ScanOnPush'])
        self.assertEqual(properties['EncryptionConfiguration']['EncryptionType'], 'AES256')
        self.assertNotIn('RepositoryPolicyText', properties)
        self.assertNotIn('LifecyclePolicy', properties)  # Do not prune rollback releases.

    def test_publisher_cannot_delete_images_change_iam_or_write_other_repositories(self):
        role = self.template['Resources']['GitHubPublishRole']['Properties']
        statements = role['Policies'][0]['PolicyDocument']['Statement']
        self.assertEqual(len(statements), 2)
        wildcard = [entry for entry in statements if entry['Resource'] == '*']
        self.assertEqual(len(wildcard), 1)
        self.assertEqual(wildcard[0]['Action'], 'ecr:GetAuthorizationToken')
        repository = next(entry for entry in statements if entry['Resource'] != '*')
        self.assertEqual(repository['Resource'], {'Fn::GetAtt':['Repository','Arn']})
        allowed = set(repository['Action'])
        self.assertIn('ecr:PutImage', allowed)
        self.assertIn('ecr:DescribeImages', allowed)
        self.assertFalse(any('*' in action or not action.startswith('ecr:') or 'Delete' in action for action in allowed))

    def test_oidc_subjects_accept_legacy_and_immutable_ids_but_never_wildcard_or_another_ref(self):
        parameter = self.template['Parameters']['GitHubOidcSubject']
        pattern = parameter['AllowedPattern']
        self.assertEqual(parameter['Default'], 'repo:kimestelle@137699667/3d-product-suite@1421629111:ref:refs/heads/main')
        for value in ('', 'repo:kimestelle/3d-product-suite:ref:refs/heads/main',
                      'repo:kimestelle@123/3d-product-suite@456:ref:refs/heads/main'):
            self.assertRegex(value, pattern)
        for value in ('repo:kimestelle/*:ref:refs/heads/main', 'repo:kimestelle/repo:*',
                      'repo:kimestelle/repo:ref:refs/heads/feature',
                      'repo:kimestelle/repo:pull_request', 'repo:kimestelle/repo:environment:production'):
            self.assertIsNone(re.fullmatch(pattern, value), value)
        trust = self.template['Resources']['GitHubPublishRole']['Properties']['AssumeRolePolicyDocument']['Statement'][0]
        self.assertEqual(trust['Action'], 'sts:AssumeRoleWithWebIdentity')
        self.assertEqual(set(trust['Condition']), {'StringEquals'})
        match = trust['Condition']['StringEquals']
        self.assertEqual(match['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com')
        self.assertEqual(match['token.actions.githubusercontent.com:sub']['Fn::If'][2],
                         {'Fn::Sub':'repo:${GitHubRepository}:ref:refs/heads/main'})
        self.assertEqual(trust['Principal']['Federated']['Fn::If'],
                         ['CreateGitHubProvider',{'Ref':'GitHubProvider'},{'Ref':'ExistingGitHubOidcProviderArn'}])

    def test_manual_release_checks_the_image_before_assuming_cloud_credentials_or_pushing(self):
        workflow = (ROOT/'.github/workflows/aws-image.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotRegex(workflow, re.compile(r'^  (push|pull_request|schedule):', re.MULTILINE))
        self.assertIn("if: github.ref == 'refs/heads/main'", workflow)
        self.assertIn('default: false', workflow)
        self.assertIn('--platform linux/amd64', workflow)
        verify = workflow.index('name: Render a Cycles frame and verify software WebGL2')
        assume = workflow.index('name: Assume the main-only ECR publisher')
        publish = workflow.index('name: Publish the verified immutable release')
        self.assertLess(verify, assume)
        self.assertLess(assume, publish)
        self.assertIn('--capture-device software', workflow)
        self.assertNotIn('--require-gpu', workflow)
        for action in re.findall(r'^\s+uses: (\S+)', workflow, re.MULTILINE):
            self.assertRegex(action, r'^[\w./-]+@[a-f0-9]{40}$')
        self.assertNotIn('aws cloudformation', workflow)
        self.assertNotIn('aws ec2', workflow)


class ContainerHttpSmokeTests(unittest.TestCase):
    def test_never_sends_workspace_credentials_to_non_loopback_or_non_origin_urls(self):
        for url in ('https://api.example.com', 'http://127.0.0.1.evil:8787',
                    'http://user:password@127.0.0.1:8787', 'http://127.0.0.1:8787/path',
                    'http://127.0.0.1:8787?token=secret', 'file:///etc/passwd',
                    'http://127.0.0.1:8787#fragment', 'http://127.0.0.1'):
            with self.subTest(url=url), patch.object(smoke, 'urlopen') as request:
                with self.assertRaises(ValueError):
                    smoke.check_http(url)
                request.assert_not_called()
        self.assertEqual(smoke.loopback_origin('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')

    def test_checks_denial_and_authenticated_bootstrap_without_reporting_the_cookie_or_key(self):
        seen = []
        def request(value, **kwargs):
            seen.append(value)
            if len(seen) == 1:
                return response({'status':'ok'})
            if len(seen) == 2:
                raise unauthorized()
            self.assertEqual(value.full_url, 'http://127.0.0.1:8787/api/bootstrap')
            self.assertTrue(value.get_header('Cookie').startswith('gesso_session='))
            return response({'project':{'scene':{}},'capabilities':{'worldCleanupAvailable':True}})
        key = 'ci-only-key-' + 'a'*40
        with patch.dict(os.environ, {'GESSO_ACCESS_KEY':key,'GESSO_PUBLIC_URL':'https://gesso-ci.invalid'}), patch.object(smoke, 'urlopen', side_effect=request):
            result = smoke.check_http('http://127.0.0.1:8787')
        self.assertEqual(len(seen), 3)
        self.assertEqual(result['status'], 'ok')
        self.assertNotIn(key, json.dumps(result))
        self.assertNotIn('gesso_session', json.dumps(result))

    def test_public_workspace_or_cacheable_unauthorized_response_fails_before_authentication(self):
        for second in (response({'project':{}}), unauthorized(private=False)):
            with self.subTest(second=type(second).__name__):
                effects = [response({'status':'ok'}), second]
                with patch.object(smoke, 'urlopen', side_effect=effects) as request:
                    with self.assertRaises(ValueError):
                        smoke.check_http('http://127.0.0.1:8787')
                    self.assertEqual(request.call_count, 2)


if __name__ == '__main__':
    unittest.main()
